// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

const NOW = "2026-10-09T00:00:00.000Z";

// One fresh file database per test so migration state and seeded rows never
// leak across cases.
function withTestDatabase<A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-056-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return effect.pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const test = (name: string, run: () => Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
  it.effect(name, () => withTestDatabase(run()));

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

describe("056_ProjectMemories", () => {
  test("creates the memory table, the contentless trigram index, and its triggers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN ('project_memories', 'project_memory_fts')
      `;
      assert.deepEqual(tables.map((row) => row.name).sort(), [
        "project_memories",
        "project_memory_fts",
      ]);

      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'project_memories_project_tombstone'
      `;
      assert.equal(triggers.length, 1);
    }));

  test("declares a contentless trigram index and persists secure-delete", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });

      // Creation options (content/contentless_delete/tokenize) live only in
      // the CREATE statement text in sqlite_schema — they are NOT written to
      // the %_config shadow table.
      const ddl = yield* sql<{ readonly ddl: string }>`
        SELECT sql AS ddl FROM sqlite_schema WHERE name = 'project_memory_fts'
      `;
      assert.equal(ddl.length, 1);
      assert.match(ddl[0]!.ddl, /content\s*=\s*''/);
      assert.match(ddl[0]!.ddl, /contentless_delete\s*=\s*1/);
      assert.match(ddl[0]!.ddl, /tokenize\s*=\s*'trigram'/);

      // Only 'secure-delete' is a runtime flag persisted in %_config.
      const config = yield* sql<{ readonly k: string; readonly v: unknown }>`
        SELECT k, v FROM project_memory_fts_config
      `;
      const options = new Map(config.map((row) => [row.k, row.v]));
      expect(options.get("secure-delete")).toBe(1);
    }));

  test("removes a project's memories and index rows when the project is tombstoned", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");
      expect((yield* memoryRows).length).toBe(1);
      expect((yield* ftsRows).length).toBe(1);

      yield* sql`
        UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'
      `;

      expect((yield* memoryRows).length).toBe(0);
      expect((yield* ftsRows).length).toBe(0);
    }));

  test("does not fire on a raw projection delete — user fact rows survive rebuilds", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");

      yield* sql`DELETE FROM projection_projects WHERE project_id = 'project-1'`;

      expect((yield* memoryRows).length).toBe(1);
      expect((yield* ftsRows).length).toBe(1);
    }));

  test("only fires on the NULL -> non-NULL tombstone transition", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 56 });
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");

      // Touching an already-NULL deleted_at must not delete anything.
      yield* sql`
        UPDATE projection_projects SET deleted_at = NULL WHERE project_id = 'project-1'
      `;
      expect((yield* memoryRows).length).toBe(1);

      // Unrelated column updates leave the rows alone.
      yield* sql`
        UPDATE projection_projects SET title = 'Renamed' WHERE project_id = 'project-1'
      `;
      expect((yield* memoryRows).length).toBe(1);
    }));
});
