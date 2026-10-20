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
import Migration0061 from "./061_ProjectSkillLifecycle.ts";

const NOW = "2026-10-12T00:00:00.000Z";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

// One fresh file database per test so migration state and seeded rows never
// leak across cases (same harness as 059/060). 061 is not registered in
// Migrations.ts yet, so the run is pinned just below it and this migration
// module is applied directly.
function withTestDatabase<A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-061-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 59 });
    // From the 59 database, the pinned step executes exactly migration 60.
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 60 }), [
      [60, "ProjectSkillManagedSend"],
    ]);
    yield* Migration0061;
    yield* effect;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const test = (name: string, run: () => Effect.Effect<unknown, unknown, SqlClient.SqlClient>) =>
  it.effect(name, () => withTestDatabase(run()));

const seedVersion = (input: {
  readonly projectId: string;
  readonly skillId: string;
  readonly version: number;
  readonly contentSha256: string;
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
        ${input.skillId}, ${input.projectId}, ${input.version}, '{"title":"t"}',
        ${input.contentSha256}, '{"type":"work"}', 'thread-1', 20, 5, 50, ${NOW}
      )
    `;
  });

const seedJudgmentRow = (input: { readonly judgmentId: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_judgments (
        judgment_id, project_id, skill_id, version, content_sha256, kind,
        judgment_json, recorded_after_event_sequence, withdrawn_at
      )
      VALUES (${input.judgmentId}, 'project-1', 'sk-1', 1, ${SHA}, 'rights',
        '{"kind":"rights"}', 10, NULL)
    `;
  });

const seedHoldRow = (input: {
  readonly holdId: string;
  readonly version: number;
  readonly contentSha256: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_holds (
        hold_id, project_id, skill_id, version, content_sha256, kind,
        evidence_scope, thread_id, message_id, attempt_id,
        observed_at_event_sequence, hold_json, created_at
      )
      VALUES (${input.holdId}, 'project-1', 'sk-1', ${input.version},
        ${input.contentSha256}, 'failure-observed', NULL, 'thread-1', 'message-1',
        'attempt-1', 20, '{"kind":"failure-observed"}', ${NOW})
    `;
  });

const stateSeq = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly seq: number }>`
    SELECT seq FROM project_skill_state WHERE project_id = 'project-1'
  `;
  return rows[0]?.seq ?? 0;
});

const activeRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly skillId: string; readonly version: number }>`
    SELECT skill_id AS "skillId", version AS "version"
    FROM project_skill_versions WHERE state = 'active'
  `;
});

describe("061_ProjectSkillLifecycle", () => {
  test("applies idempotently and keeps at most one active version per project", () =>
    Effect.gen(function* () {
      // CREATE IF NOT EXISTS everywhere: a second application is a no-op.
      yield* Migration0061;

      yield* seedVersion({
        projectId: "project-1",
        skillId: "sk-a",
        version: 1,
        contentSha256: SHA,
      });
      yield* seedVersion({
        projectId: "project-1",
        skillId: "sk-a",
        version: 2,
        contentSha256: OTHER_SHA,
      });
      yield* seedVersion({
        projectId: "project-1",
        skillId: "sk-b",
        version: 1,
        contentSha256: SHA,
      });

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = 'sk-a' AND version = 1`;
      assert.deepEqual(yield* activeRows, [{ skillId: "sk-a", version: 1 }]);

      // The index is per project, across skills: neither a second version of
      // the same skill nor another skill may join it while one is active.
      const secondVersion = yield* Effect.exit(
        sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = 'sk-a' AND version = 2`,
      );
      assert.ok(Exit.isFailure(secondVersion));
      const otherSkill = yield* Effect.exit(
        sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = 'sk-b' AND version = 1`,
      );
      assert.ok(Exit.isFailure(otherSkill));
      assert.deepEqual(yield* activeRows, [{ skillId: "sk-a", version: 1 }]);

      yield* sql`UPDATE project_skill_versions SET state = 'retired', retired_reason = 'user-retired'
        WHERE skill_id = 'sk-a' AND version = 1`;
      yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = 'sk-b' AND version = 1`;
      assert.deepEqual(yield* activeRows, [{ skillId: "sk-b", version: 1 }]);
    }));

  test("hold rows are append-only and purge with their version", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedVersion({
        projectId: "project-1",
        skillId: "sk-1",
        version: 1,
        contentSha256: SHA,
      });
      yield* seedVersion({
        projectId: "project-1",
        skillId: "sk-1",
        version: 2,
        contentSha256: OTHER_SHA,
      });
      yield* seedHoldRow({ holdId: "psh-hold-v1", version: 1, contentSha256: SHA });
      yield* seedHoldRow({ holdId: "psh-hold-v2", version: 2, contentSha256: OTHER_SHA });

      // Release is derived, never written: any UPDATE aborts.
      const rewritten = yield* Effect.exit(sql`
        UPDATE project_skill_holds SET created_at = ${NOW} WHERE hold_id = 'psh-hold-v1'
      `);
      assert.ok(Exit.isFailure(rewritten));

      // The version-delete purge is scoped to the deleted ref's holds.
      yield* sql`DELETE FROM project_skill_versions WHERE version = 1`;
      const remaining = yield* sql<{ readonly holdId: string }>`
        SELECT hold_id AS "holdId" FROM project_skill_holds
      `;
      assert.deepEqual(remaining, [{ holdId: "psh-hold-v2" }]);
    }));

  test("judgment insert, one-way withdrawal, and hold insert each bump the state sequence", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedVersion({
        projectId: "project-1",
        skillId: "sk-1",
        version: 1,
        contentSha256: SHA,
      });
      assert.equal(yield* stateSeq, 0);

      yield* seedJudgmentRow({ judgmentId: "psj-1" });
      assert.equal(yield* stateSeq, 1);

      yield* sql`UPDATE project_skill_judgments SET withdrawn_at = ${NOW} WHERE judgment_id = 'psj-1'`;
      assert.equal(yield* stateSeq, 2);

      // The withdrawal is one-way: the append-only trigger refuses a second
      // touch and the sequence stays.
      const again = yield* Effect.exit(sql`
        UPDATE project_skill_judgments SET withdrawn_at = ${NOW} WHERE judgment_id = 'psj-1'
      `);
      assert.ok(Exit.isFailure(again));
      assert.equal(yield* stateSeq, 2);

      yield* seedHoldRow({ holdId: "psh-hold-1", version: 1, contentSha256: SHA });
      assert.equal(yield* stateSeq, 3);
    }));
});
