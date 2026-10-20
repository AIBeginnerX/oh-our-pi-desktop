// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const NOW = "2026-10-09T00:00:00.000Z";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

// One fresh file database per test so migration state and seeded rows never
// leak across cases (same harness as 056/057).
function withTestDatabase<A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-058-"));
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

const seedThread = (projectId: string, threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (${threadId}, ${projectId}, 'Thread', '{}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
    `;
  });

const seedMemory = (projectId: string, memoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_memories (
        memory_id, project_id, kind, title, body, version,
        origin_type, origin_thread_id, origin_message_id,
        valid_until, estimated_tokens, created_at, updated_at
      )
      VALUES (${memoryId}, ${projectId}, 'fact', 'Deploy runbook', 'Restart the server', 1,
        'manual', NULL, NULL, NULL, 10, ${NOW}, ${NOW})
    `;
  });

const seedVersion = (input: {
  readonly projectId: string;
  readonly skillId: string;
  readonly version?: number;
  readonly contentSha256?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_versions (
        skill_id, project_id, version, content_json, content_sha256,
        source_json, source_thread_id, source_receipt_sequence,
        source_thread_created_sequence, created_after_event_sequence, created_at
      )
      VALUES (
        ${input.skillId}, ${input.projectId}, ${input.version ?? 1}, '{"title":"t"}',
        ${input.contentSha256 ?? SHA}, '{"type":"work"}', 'thread-1', 20, 5, 50, ${NOW}
      )
    `;
  });

const seedJudgment = (input: {
  readonly projectId: string;
  readonly skillId: string;
  readonly judgmentId?: string;
  readonly kind?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_judgments (
        judgment_id, project_id, skill_id, version, content_sha256, kind,
        judgment_json, recorded_after_event_sequence, withdrawn_at
      )
      VALUES (
        ${input.judgmentId ?? "psj-1"}, ${input.projectId}, ${input.skillId}, 1, ${SHA},
        ${input.kind ?? "rights"}, '{"kind":"rights"}', 51, NULL
      )
    `;
  });

const versionRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly skillId: string; readonly version: number }>`
    SELECT skill_id AS "skillId", version AS "version" FROM project_skill_versions
  `;
});

const judgmentRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly judgmentId: string; readonly withdrawnAt: string | null }>`
    SELECT judgment_id AS "judgmentId", withdrawn_at AS "withdrawnAt" FROM project_skill_judgments
  `;
});

describe("058_ProjectSkills", () => {
  test("upgrades a 057 database with live memory data, creates tables and triggers, idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 57 });
      yield* seedProject("project-1");
      yield* seedMemory("project-1", "mem-1");

      const executed = yield* runMigrations({ toMigrationInclusive: 58 });
      assert.deepEqual(executed, [[58, "ProjectSkills"]]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN ('project_skill_versions', 'project_skill_judgments')
      `;
      assert.deepEqual(tables.map((row) => row.name).sort(), [
        "project_skill_judgments",
        "project_skill_versions",
      ]);

      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name LIKE 'project_skill_%'
        ORDER BY name
      `;
      assert.deepEqual(
        triggers.map((row) => row.name),
        [
          "project_skill_judgments_append_only",
          "project_skill_project_tombstone",
          "project_skill_versions_immutable",
        ],
      );

      // Idempotent: a second run up to 58 executes nothing, and the 056-era data
      // this slice shares a database with is untouched.
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 58 }), []);
      const memories = yield* sql<{ readonly memoryId: string }>`
        SELECT memory_id AS "memoryId" FROM project_memories
      `;
      assert.deepEqual(
        memories.map((row) => row.memoryId),
        ["mem-1"],
      );
    }));

  test("enforces both version identity UNIQUE constraints", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1", contentSha256: SHA });

      const sameVersion = yield* Effect.exit(
        seedVersion({
          projectId: "project-1",
          skillId: "sk-1",
          version: 1,
          contentSha256: OTHER_SHA,
        }),
      );
      assert.ok(Exit.isFailure(sameVersion));

      const sameContent = yield* Effect.exit(
        seedVersion({ projectId: "project-1", skillId: "sk-1", version: 2, contentSha256: SHA }),
      );
      assert.ok(Exit.isFailure(sameContent));

      // A different skill is a different identity and still inserts.
      yield* seedVersion({ projectId: "project-1", skillId: "sk-2", contentSha256: SHA });
      assert.equal((yield* versionRows).length, 2);
    }));

  test("freezes identity, content, and provenance columns but leaves state mutable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });

      for (const attempt of [
        sql`UPDATE project_skill_versions SET content_json = '{"title":"x"}' WHERE skill_id = 'sk-1'`,
        sql`UPDATE project_skill_versions SET content_sha256 = ${OTHER_SHA} WHERE skill_id = 'sk-1'`,
        sql`UPDATE project_skill_versions SET version = 2 WHERE skill_id = 'sk-1'`,
        sql`UPDATE project_skill_versions SET source_thread_id = 'thread-2' WHERE skill_id = 'sk-1'`,
        sql`UPDATE project_skill_versions SET created_after_event_sequence = 1 WHERE skill_id = 'sk-1'`,
      ]) {
        assert.ok(Exit.isFailure(yield* Effect.exit(attempt)));
      }

      // The state transition is the one mutation a later slice may make.
      yield* sql`UPDATE project_skill_versions SET state = 'retired' WHERE skill_id = 'sk-1'`;
      const state = yield* sql<{ readonly state: string }>`
        SELECT state FROM project_skill_versions WHERE skill_id = 'sk-1'
      `;
      assert.equal(state[0]?.state, "retired");
      const content = yield* sql<{ readonly contentJson: string }>`
        SELECT content_json AS "contentJson" FROM project_skill_versions WHERE skill_id = 'sk-1'
      `;
      assert.equal(content[0]?.contentJson, '{"title":"t"}');
    }));

  test("permits only the one-way withdrawn_at NULL to non-NULL transition", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* seedJudgment({ projectId: "project-1", skillId: "sk-1" });

      // The supported withdrawal.
      yield* sql`
        UPDATE project_skill_judgments SET withdrawn_at = ${NOW} WHERE judgment_id = 'psj-1'
      `;
      let rows = yield* judgmentRows;
      assert.equal(rows[0]?.withdrawnAt, NOW);

      // value -> other value, value -> NULL, and a withdrawal bundled with any
      // other column change all abort; content is never edited.
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            sql`UPDATE project_skill_judgments SET withdrawn_at = 'later' WHERE judgment_id = 'psj-1'`,
          ),
        ),
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            sql`UPDATE project_skill_judgments SET withdrawn_at = NULL WHERE judgment_id = 'psj-1'`,
          ),
        ),
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            sql`
              UPDATE project_skill_judgments
              SET withdrawn_at = ${NOW}, judgment_json = '{"kind":"rights","edited":true}'
              WHERE judgment_id = 'psj-1'
            `,
          ),
        ),
      );
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            sql`UPDATE project_skill_judgments SET judgment_json = '{"kind":"rights"}' WHERE judgment_id = 'psj-1'`,
          ),
        ),
      );
      rows = yield* judgmentRows;
      assert.equal(rows[0]?.withdrawnAt, NOW);
      assert.equal(rows[0]?.judgmentId, "psj-1");

      // The binding counterexample on a fresh, not-yet-withdrawn row:
      // bundling a judgment_json edit with the withdrawal aborts, and the row
      // keeps both original values — withdrawn_at still NULL, JSON untouched.
      yield* seedJudgment({ projectId: "project-1", skillId: "sk-1", judgmentId: "psj-fresh" });
      assert.ok(
        Exit.isFailure(
          yield* Effect.exit(
            sql`
              UPDATE project_skill_judgments
              SET withdrawn_at = ${NOW}, judgment_json = '{"kind":"rights","edited":true}'
              WHERE judgment_id = 'psj-fresh'
            `,
          ),
        ),
      );
      const freshRows = yield* sql<{
        readonly withdrawnAt: string | null;
        readonly judgmentJson: string;
      }>`
        SELECT withdrawn_at AS "withdrawnAt", judgment_json AS "judgmentJson"
        FROM project_skill_judgments
        WHERE judgment_id = 'psj-fresh'
      `;
      assert.equal(freshRows[0]?.withdrawnAt, null);
      assert.equal(freshRows[0]?.judgmentJson, '{"kind":"rights"}');
    }));

  test("project tombstone deletes skill data; raw deletes and thread tombstones keep it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      yield* seedThread("project-1", "thread-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* seedVersion({ projectId: "project-2", skillId: "sk-2" });
      yield* seedJudgment({ projectId: "project-1", skillId: "sk-1" });
      yield* seedJudgment({ projectId: "project-2", skillId: "sk-2", judgmentId: "psj-2" });

      // Thread tombstones never touch skill data — the source snapshot stays.
      yield* sql`UPDATE projection_threads SET deleted_at = ${NOW} WHERE thread_id = 'thread-1'`;
      assert.equal((yield* versionRows).length, 2);
      assert.equal((yield* judgmentRows).length, 2);

      // Raw projection deletes only orphan rows; reads hide them.
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'project-1'`;
      assert.equal((yield* versionRows).length, 2);
      assert.equal((yield* judgmentRows).length, 2);

      // The real tombstone transition deletes that project's rows only.
      yield* sql`
        UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-2'
      `;
      assert.deepEqual(yield* versionRows, [{ skillId: "sk-1", version: 1 }]);
      assert.deepEqual(yield* judgmentRows, [{ judgmentId: "psj-1", withdrawnAt: null }]);
    }));

  test("rejects unknown judgment kinds and version states", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });

      const badKind = yield* Effect.exit(
        seedJudgment({ projectId: "project-1", skillId: "sk-1", kind: "bogus" }),
      );
      assert.ok(Exit.isFailure(badKind));

      yield* seedJudgment({ projectId: "project-1", skillId: "sk-1" });
      const badState = yield* Effect.exit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE project_skill_versions SET state = 'bogus' WHERE skill_id = 'sk-1'`;
        }),
      );
      assert.ok(Exit.isFailure(badState));

      const badRetiredReason = yield* Effect.exit(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE project_skill_versions SET state = 'retired', retired_reason = 'bogus'
            WHERE skill_id = 'sk-1'
          `;
        }),
      );
      assert.ok(Exit.isFailure(badRetiredReason));
      assert.equal((yield* judgmentRows).length, 1);
    }));
});
