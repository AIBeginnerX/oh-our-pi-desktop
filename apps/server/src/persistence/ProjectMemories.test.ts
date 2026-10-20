// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MessageId, ProjectId, ProjectMemoryId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";
import { ProjectMemoryRepository, layer as projectMemoriesLayer } from "./ProjectMemories.ts";

// One fresh file database per test: rows, tombstones, and FTS state never
// leak across cases (same shape as ProviderSafetyObservations.test.ts).
function withTestDatabase<A, E, R>(
  effect: Effect.Effect<A, E, R | ProjectMemoryRepository | SqlClient.SqlClient>,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-project-memories-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return effect.pipe(
    Effect.provide(
      projectMemoriesLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath }))),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const NOW = "2026-10-09T00:00:00.000Z";

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

const insertInput = (overrides: {
  readonly memoryId: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly body?: string;
  readonly kind?: "fact" | "procedure" | "work-log";
  readonly origin?:
    | { readonly type: "manual" }
    | { readonly type: "message"; readonly threadId: string; readonly messageId: string };
}) => ({
  memoryId: ProjectMemoryId.make(overrides.memoryId),
  projectId: ProjectId.make(overrides.projectId ?? "project-1"),
  kind: overrides.kind ?? ("fact" as const),
  title: overrides.title ?? "Deploy runbook",
  body: overrides.body ?? "Run migrations then restart the server",
  origin:
    overrides.origin === undefined
      ? ({ type: "manual" } as const)
      : overrides.origin.type === "manual"
        ? ({ type: "manual" } as const)
        : {
            type: "message" as const,
            threadId: ThreadId.make(overrides.origin.threadId),
            messageId: MessageId.make(overrides.origin.messageId),
          },
  validUntil: null,
  estimatedTokens: 10,
  now: NOW,
});

const updateInput = (overrides: {
  readonly memoryId: string;
  readonly expectedVersion: number;
  readonly projectId?: string;
  readonly title?: string;
  readonly body?: string;
}) => ({
  projectId: ProjectId.make(overrides.projectId ?? "project-1"),
  memoryId: ProjectMemoryId.make(overrides.memoryId),
  expectedVersion: overrides.expectedVersion,
  title: overrides.title ?? "Deploy runbook v2",
  body: overrides.body ?? "Run migrations, restart, then warm the cache",
  kind: "procedure" as const,
  validUntil: null,
  estimatedTokens: 12,
  now: "2026-10-09T01:00:00.000Z",
});

const ftsCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly c: number }>`
    SELECT COUNT(*) AS c FROM project_memory_fts
  `;
  return rows[0]?.c ?? -1;
});

const memoryCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly c: number }>`
    SELECT COUNT(*) AS c FROM project_memories
  `;
  return rows[0]?.c ?? -1;
});

const test = (
  name: string,
  run: () => Effect.Effect<unknown, unknown, ProjectMemoryRepository | SqlClient.SqlClient>,
) => it.effect(name, () => withTestDatabase(run()));

describe("ProjectMemoryRepository", () => {
  test("inserts and reads back a memory with provenance fields", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;

      const outcome = yield* repository.insert(insertInput({ memoryId: "mem-1" }));
      assert.equal(outcome.status, "applied");
      if (outcome.status !== "applied") return;
      assert.equal(outcome.record.version, 1);
      assert.equal(outcome.record.kind, "fact");
      assert.deepEqual(outcome.record.origin, { type: "manual" });
      assert.equal(outcome.record.title, "Deploy runbook");

      const loaded = yield* repository.getById({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
      });
      assert.isTrue(Option.isSome(loaded));
      assert.equal(Option.getOrThrow(loaded).body, "Run migrations then restart the server");

      expect(yield* ftsCount).toBe(1);
    }));

  test("keeps project listings isolated", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      const repository = yield* ProjectMemoryRepository;

      yield* repository.insert(insertInput({ memoryId: "mem-a", projectId: "project-1" }));
      yield* repository.insert(insertInput({ memoryId: "mem-b", projectId: "project-2" }));

      const page = yield* repository.listForProject({
        projectId: ProjectId.make("project-1"),
        limit: 100,
      });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.memoryId, "mem-a");
      assert.isFalse(page.truncated);
    }));

  test("marks truncated when more rows than the limit exist", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      for (const id of ["m1", "m2", "m3"]) {
        yield* repository.insert(insertInput({ memoryId: id }));
      }

      const page = yield* repository.listForProject({
        projectId: ProjectId.make("project-1"),
        limit: 2,
      });
      assert.equal(page.items.length, 2);
      assert.isTrue(page.truncated);
    }));

  test("rejects inserts for missing and tombstoned projects", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;

      const missing = yield* repository.insert(
        insertInput({ memoryId: "mem-1", projectId: "project-ghost" }),
      );
      assert.deepEqual(missing, { status: "project-missing" });

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'`;
      const tombstoned = yield* repository.insert(insertInput({ memoryId: "mem-2" }));
      assert.deepEqual(tombstoned, { status: "project-missing" });
      expect(yield* memoryCount).toBe(0);
      expect(yield* ftsCount).toBe(0);
    }));

  test("verifies message provenance atomically inside the insert", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      yield* seedThread("project-1", "thread-1");
      yield* seedThread("project-1", "thread-2", NOW);
      yield* seedMessage("thread-1", "msg-1");
      const repository = yield* ProjectMemoryRepository;

      const valid = yield* repository.insert(
        insertInput({
          memoryId: "mem-1",
          origin: { type: "message", threadId: "thread-1", messageId: "msg-1" },
        }),
      );
      assert.equal(valid.status, "applied");
      if (valid.status === "applied") {
        assert.deepEqual(valid.record.origin, {
          type: "message",
          threadId: ThreadId.make("thread-1"),
          messageId: MessageId.make("msg-1"),
        });
      }

      // Same message, claimed under a different project: rejected, not stored.
      const wrongProject = yield* repository.insert(
        insertInput({
          memoryId: "mem-2",
          projectId: "project-2",
          origin: { type: "message", threadId: "thread-1", messageId: "msg-1" },
        }),
      );
      assert.deepEqual(wrongProject, { status: "origin-invalid" });

      // A message id under a different thread of the same project does not count.
      const wrongThread = yield* repository.insert(
        insertInput({
          memoryId: "mem-3",
          origin: { type: "message", threadId: "thread-2", messageId: "msg-1" },
        }),
      );
      assert.deepEqual(wrongThread, { status: "origin-invalid" });

      // Tombstoned threads are not valid provenance either.
      yield* seedMessage("thread-2", "msg-2");
      const deadThread = yield* repository.insert(
        insertInput({
          memoryId: "mem-4",
          origin: { type: "message", threadId: "thread-2", messageId: "msg-2" },
        }),
      );
      assert.deepEqual(deadThread, { status: "origin-invalid" });
      expect(yield* memoryCount).toBe(1);
    }));

  test("applies an expectedVersion update and reindexes FTS", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(
        insertInput({ memoryId: "mem-1", title: "Old title", body: "old body" }),
      );

      const outcome = yield* repository.update(
        updateInput({ memoryId: "mem-1", expectedVersion: 1, title: "New searchable title" }),
      );
      assert.equal(outcome.status, "applied");
      if (outcome.status !== "applied") return;
      assert.equal(outcome.record.version, 2);
      assert.equal(outcome.record.title, "New searchable title");

      const found = yield* repository.search({
        projectId: ProjectId.make("project-1"),
        ftsMatch: '"searchable"',
        likePatterns: [],
        limit: 100,
      });
      assert.equal(found.items.length, 1);
      assert.equal(found.items[0]?.title, "New searchable title");

      // The stale term must be gone — a contentless index only forgets what is
      // explicitly deleted.
      const staleOld = yield* repository.search({
        projectId: ProjectId.make("project-1"),
        ftsMatch: '"old"',
        likePatterns: [],
        limit: 100,
      });
      assert.equal(staleOld.items.length, 0);
    }));

  test("reports version conflicts without mutating the row", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(insertInput({ memoryId: "mem-1" }));

      const outcome = yield* repository.update(
        updateInput({ memoryId: "mem-1", expectedVersion: 7 }),
      );
      assert.deepEqual(outcome, { status: "conflict", currentVersion: 1 });

      const still = yield* repository.getById({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
      });
      assert.equal(Option.getOrThrow(still).title, "Deploy runbook");
    }));

  test("reports not-found on update of a missing memory", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      const outcome = yield* repository.update(
        updateInput({ memoryId: "mem-gone", expectedVersion: 1 }),
      );
      assert.deepEqual(outcome, { status: "not-found" });
    }));

  test("refuses writes once the owning project is tombstoned", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(insertInput({ memoryId: "mem-1" }));

      const sql = yield* SqlClient.SqlClient;
      // Tombstoning fires the migration trigger, which removes the row and its
      // index entry inside that statement's transaction.
      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'`;
      expect(yield* memoryCount).toBe(0);
      expect(yield* ftsCount).toBe(0);

      // Re-create the same project id live (un-tombstone): the restored
      // project must not resurrect the wiped memory, and a new write under
      // that id is accepted.
      yield* sql`UPDATE projection_projects SET deleted_at = NULL WHERE project_id = 'project-1'`;
      const recreated = yield* repository.insert(insertInput({ memoryId: "mem-2" }));
      assert.equal(recreated.status, "applied");
      const page = yield* repository.listForProject({
        projectId: ProjectId.make("project-1"),
        limit: 100,
      });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.memoryId, "mem-2");
    }));

  test("hides orphaned rows after a raw project delete without wiping them", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(insertInput({ memoryId: "mem-1" }));

      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'project-1'`;

      // Reads hide the orphan behind the live-project filter...
      const page = yield* repository.listForProject({
        projectId: ProjectId.make("project-1"),
        limit: 100,
      });
      assert.equal(page.items.length, 0);
      // ...writes refuse it like any missing project...
      const write = yield* repository.insert(
        insertInput({ memoryId: "mem-2", projectId: "project-1" }),
      );
      assert.deepEqual(write, { status: "project-missing" });
      // ...and crucially the stored fact data survives a projection rebuild.
      expect(yield* memoryCount).toBe(1);
      expect(yield* ftsCount).toBe(1);
    }));

  test("deletes a row and its FTS entry atomically", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(insertInput({ memoryId: "mem-1" }));

      const outcome = yield* repository.delete({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
        expectedVersion: 1,
      });
      assert.equal(outcome.status, "applied");

      expect(yield* memoryCount).toBe(0);
      expect(yield* ftsCount).toBe(0);
      const gone = yield* repository.getById({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
      });
      assert.isTrue(Option.isNone(gone));
    }));

  test("rolls the whole delete back when the FTS statement fails", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(insertInput({ memoryId: "mem-1" }));

      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE project_memory_fts RENAME TO project_memory_fts_broken`;

      const exit = yield* repository
        .delete({
          projectId: ProjectId.make("project-1"),
          memoryId: ProjectMemoryId.make("mem-1"),
          expectedVersion: 1,
        })
        .pipe(Effect.exit);
      assert.isTrue(exit._tag === "Failure");

      yield* sql`ALTER TABLE project_memory_fts_broken RENAME TO project_memory_fts`;
      // The row DELETE and the index DELETE share one transaction: the row
      // must still be there with its version intact, not half-committed.
      expect(yield* memoryCount).toBe(1);
      const still = yield* repository.getById({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
      });
      assert.equal(Option.getOrThrow(still).version, 1);
    }));

  test("reports delete conflicts and not-found distinctly", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(insertInput({ memoryId: "mem-1" }));

      const conflict = yield* repository.delete({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-1"),
        expectedVersion: 3,
      });
      assert.deepEqual(conflict, { status: "conflict", currentVersion: 1 });

      const missing = yield* repository.delete({
        projectId: ProjectId.make("project-1"),
        memoryId: ProjectMemoryId.make("mem-gone"),
        expectedVersion: 1,
      });
      assert.deepEqual(missing, { status: "not-found" });
    }));

  test("combines FTS terms and LIKE fallback with AND semantics", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(
        insertInput({ memoryId: "mem-1", title: "배포 절차", body: "staging 먼저 확인" }),
      );
      yield* repository.insert(
        insertInput({ memoryId: "mem-2", title: "배포 UI", body: "no staging here" }),
      );

      // 3+ codepoint term via FTS plus a 1-2 codepoint term via LIKE; both
      // must match for a row to appear.
      const page = yield* repository.search({
        projectId: ProjectId.make("project-1"),
        ftsMatch: '"staging"',
        likePatterns: ["%UI%"],
        limit: 100,
      });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.memoryId, "mem-2");

      // LIKE wildcards in the pattern were escaped by the planner — fed what
      // the planner emits for term `배_`, an underscore does not stand in for
      // a single character.
      const literal = yield* repository.search({
        projectId: ProjectId.make("project-1"),
        ftsMatch: null,
        likePatterns: ["%배!_%"],
        limit: 100,
      });
      assert.equal(literal.items.length, 0);
    }));

  test("scopes FTS hits to the requested project", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      const repository = yield* ProjectMemoryRepository;
      yield* repository.insert(
        insertInput({ memoryId: "mem-a", projectId: "project-1", title: "shared deploy term" }),
      );
      yield* repository.insert(
        insertInput({ memoryId: "mem-b", projectId: "project-2", title: "shared deploy term" }),
      );

      const page = yield* repository.search({
        projectId: ProjectId.make("project-1"),
        ftsMatch: '"deploy"',
        likePatterns: [],
        limit: 100,
      });
      assert.equal(page.items.length, 1);
      assert.equal(page.items[0]?.memoryId, "mem-a");
    }));
});
