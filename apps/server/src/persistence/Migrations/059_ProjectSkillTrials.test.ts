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

const NOW = "2026-10-12T00:00:00.000Z";
const SHA = "a".repeat(64);

// One fresh file database per test so migration state and seeded rows never
// leak across cases (same harness as 056/057/058).
function withTestDatabase<A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-059-"));
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

const seedVersion = (input: {
  readonly projectId: string;
  readonly skillId: string;
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
        ${input.skillId}, ${input.projectId}, 1, '{"title":"t"}',
        ${input.contentSha256 ?? SHA}, '{"type":"work"}', 'thread-1', 20, 5, 50, ${NOW}
      )
    `;
  });

// The exact row shape the trial repository writes on a claimed delivery.
const seedInput = (input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly projectId?: string;
  readonly skillId?: string;
  readonly delivery?: string;
  readonly driverKind?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_inputs (
        thread_id, message_id, project_id, skill_id, version, content_sha256,
        input_event_sequence, input_incarnation, admitted_skill_state_seq,
        provider_driver_kind, native_skill_inventory_sha256,
        delivery, delivery_at, window, window_closed_at, uncounted_attempts,
        attempt_token, claimed_at, tombstoned_at
      )
      VALUES (
        ${input.threadId}, ${input.messageId}, ${input.projectId ?? "project-1"},
        ${input.skillId ?? "sk-1"}, 1, ${SHA}, 20, 5, 0,
        ${input.driverKind ?? null}, NULL,
        ${input.delivery ?? "unknown"},
        ${input.delivery === "provider-accepted" ? NOW : null},
        'open', NULL, 0, 'token-1', ${NOW}, NULL
      )
    `;
  });

const seedObservation = (input: {
  readonly evidenceId: string;
  readonly attemptId: string;
  readonly skillId?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_observed_uses (
        evidence_id, thread_id, message_id, attempt_id, project_id,
        skill_id, version, content_sha256, check_json, receipt_sequence,
        outcome, ended_at, recorded_at
      )
      VALUES (
        ${input.evidenceId}, 'thread-1', 'message-1', ${input.attemptId}, 'project-1',
        ${input.skillId ?? "sk-1"}, 1, ${SHA}, '{"outcome":"all-selected-passed"}', 30,
        'all-selected-passed', ${NOW}, ${NOW}
      )
    `;
  });

const stateSeq = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly seq: number }>`
    SELECT seq FROM project_skill_state WHERE project_id = 'project-1'
  `;
  return rows[0]?.seq ?? 0;
});

const inputRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly skillId: string | null;
    readonly admittedSkillStateSeq: number | null;
    readonly delivery: string;
    readonly providerDriverKind: string | null;
    readonly inputEventSequence: number;
    readonly inputIncarnation: number;
    readonly window: string;
    readonly uncountedAttempts: number;
    readonly attemptToken: string;
    readonly tombstonedAt: string | null;
  }>`
    SELECT skill_id AS "skillId", admitted_skill_state_seq AS "admittedSkillStateSeq",
      delivery AS "delivery", provider_driver_kind AS "providerDriverKind",
      input_event_sequence AS "inputEventSequence", input_incarnation AS "inputIncarnation",
      window AS "window", uncounted_attempts AS "uncountedAttempts",
      attempt_token AS "attemptToken", tombstoned_at AS "tombstonedAt"
    FROM project_skill_inputs
  `;
});

describe("059_ProjectSkillTrials", () => {
  test("upgrades a 058 database with live skill data, creates tables and triggers, idempotent", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 58 });
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });

      const executed = yield* runMigrations({ toMigrationInclusive: 59 });
      assert.deepEqual(executed, [[59, "ProjectSkillTrials"]]);

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE name IN ('project_skill_state', 'project_skill_inputs', 'project_skill_observed_uses')
      `;
      assert.deepEqual(tables.map((row) => row.name).sort(), [
        "project_skill_inputs",
        "project_skill_observed_uses",
        "project_skill_state",
      ]);

      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'project_skill_state_on_version_state',
          'project_skill_trials_on_version_delete',
          'project_skill_inputs_transitions',
          'project_skill_observed_uses_append_only'
        )
        ORDER BY name
      `;
      assert.deepEqual(
        triggers.map((row) => row.name),
        [
          "project_skill_inputs_transitions",
          "project_skill_observed_uses_append_only",
          "project_skill_state_on_version_state",
          "project_skill_trials_on_version_delete",
        ],
      );

      // Idempotent: a second full run executes nothing, and the 058-era rows
      // this slice shares a database with are untouched.
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 59 }), []);
      const versions = yield* sql<{ readonly skillId: string }>`
        SELECT skill_id AS "skillId" FROM project_skill_versions
      `;
      assert.deepEqual(
        versions.map((row) => row.skillId),
        ["sk-1"],
      );
    }));

  test("bumps the project state sequence on real state changes and deletes only", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });

      // Inserting a version is not a state change.
      assert.equal(yield* stateSeq, 0);

      yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = 'sk-1'`;
      assert.equal(yield* stateSeq, 1);

      // Writing identical values changes nothing.
      yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = 'sk-1'`;
      assert.equal(yield* stateSeq, 1);

      yield* sql`
        UPDATE project_skill_versions SET state = 'retired', retired_reason = 'user-retired'
        WHERE skill_id = 'sk-1'
      `;
      assert.equal(yield* stateSeq, 2);

      // The delete bump and the project-tombstone cascade bump alike.
      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = 'sk-1'`;
      assert.equal(yield* stateSeq, 3);

      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'`;
      assert.equal(yield* stateSeq, 4);
    }));

  test("keeps the 058 content immutability while state stays mutable", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });

      const tampered = yield* Effect.exit(
        sql`UPDATE project_skill_versions SET content_json = '{"title":"x"}' WHERE skill_id = 'sk-1'`,
      );
      assert.ok(Exit.isFailure(tampered));

      yield* sql`UPDATE project_skill_versions SET state = 'active' WHERE skill_id = 'sk-1'`;
      assert.equal(yield* stateSeq, 1);
    }));

  test("permits only settle, one-shot window closure, and the delete tombstone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* seedInput({ threadId: "thread-1", messageId: "message-1" });

      // The delivery settle with its routed driver kind.
      yield* sql`
        UPDATE project_skill_inputs SET delivery = 'provider-accepted',
          provider_driver_kind = 'claude-code', delivery_at = ${NOW}
        WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `;
      let rows = yield* inputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");

      // Settled is final: no revert, no re-settle, no driver swap.
      for (const attempt of [
        sql`UPDATE project_skill_inputs SET delivery = 'unknown', delivery_at = NULL,
            provider_driver_kind = NULL WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
        sql`UPDATE project_skill_inputs SET provider_driver_kind = 'other' WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
      ]) {
        assert.ok(Exit.isFailure(yield* Effect.exit(attempt)));
      }

      // The one-shot closure carries the computed uncounted total.
      yield* sql`
        UPDATE project_skill_inputs SET window = 'closed', window_closed_at = ${NOW},
          uncounted_attempts = 2 WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `;
      rows = yield* inputRows;
      assert.equal(rows[0]?.window, "closed");
      assert.equal(rows[0]?.uncountedAttempts, 2);

      // No reopen, no count growth after closure, no count-only edit while open.
      for (const attempt of [
        sql`UPDATE project_skill_inputs SET window = 'open', window_closed_at = NULL WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
        sql`UPDATE project_skill_inputs SET uncounted_attempts = 3 WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
      ]) {
        assert.ok(Exit.isFailure(yield* Effect.exit(attempt)));
      }
      rows = yield* inputRows;
      assert.equal(rows[0]?.window, "closed");
      assert.equal(rows[0]?.uncountedAttempts, 2);

      // Identity, canonical binding, and the ownership token never move.
      for (const attempt of [
        sql`UPDATE project_skill_inputs SET input_event_sequence = 21 WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
        sql`UPDATE project_skill_inputs SET input_incarnation = 6 WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
        sql`UPDATE project_skill_inputs SET attempt_token = 'token-2' WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
        sql`UPDATE project_skill_inputs SET thread_id = 'thread-2' WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
        sql`UPDATE project_skill_inputs SET claimed_at = ${NOW} WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
      ]) {
        assert.ok(Exit.isFailure(yield* Effect.exit(attempt)));
      }
      rows = yield* inputRows;
      assert.equal(rows[0]?.inputEventSequence, 20);
      assert.equal(rows[0]?.attemptToken, "token-1");
    }));

  test("the delete tombstone drops the payload once and settles still work on it", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* seedInput({ threadId: "thread-1", messageId: "message-1" });

      yield* sql`
        UPDATE project_skill_inputs SET skill_id = NULL, version = NULL,
          content_sha256 = NULL, admitted_skill_state_seq = NULL, tombstoned_at = ${NOW}
        WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `;
      let rows = yield* inputRows;
      assert.equal(rows[0]?.skillId, null);
      assert.equal(rows[0]?.tombstonedAt, NOW);

      // A second tombstone has no payload left to drop.
      const retombstone = yield* Effect.exit(sql`
        UPDATE project_skill_inputs SET tombstoned_at = 'later'
        WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `);
      assert.ok(Exit.isFailure(retombstone));

      // Delivery ownership survives the tombstone and still settles.
      yield* sql`
        UPDATE project_skill_inputs SET delivery = 'provider-accepted',
          provider_driver_kind = 'claude-code', delivery_at = ${NOW}
        WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `;
      rows = yield* inputRows;
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.providerDriverKind, "claude-code");
      assert.equal(rows[0]?.inputEventSequence, 20);
    }));

  test("version delete purges observations and keeps the payload-free ownership row", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* seedInput({
        threadId: "thread-1",
        messageId: "message-1",
        delivery: "provider-accepted",
        driverKind: "claude-code",
      });
      yield* seedObservation({ evidenceId: "pse-1", attemptId: "attempt-1" });

      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = 'sk-1'`;

      const observations = yield* sql<{ readonly evidenceId: string }>`
        SELECT evidence_id AS "evidenceId" FROM project_skill_observed_uses
      `;
      assert.deepEqual(observations, []);

      const rows = yield* inputRows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.skillId, null);
      assert.equal(rows[0]?.admittedSkillStateSeq, null);
      assert.equal(rows[0]?.tombstonedAt !== null, true);
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.providerDriverKind, "claude-code");
      assert.equal(rows[0]?.inputEventSequence, 20);
      assert.equal(rows[0]?.inputIncarnation, 5);
      assert.equal(rows[0]?.attemptToken, "token-1");
      assert.equal(yield* stateSeq, 1);
    }));

  test("observed uses are append-only and unique per attempt", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedObservation({ evidenceId: "pse-1", attemptId: "attempt-1" });

      const rewritten = yield* Effect.exit(sql`
        UPDATE project_skill_observed_uses SET outcome = 'failed' WHERE evidence_id = 'pse-1'
      `);
      assert.ok(Exit.isFailure(rewritten));

      const duplicated = yield* Effect.exit(
        seedObservation({ evidenceId: "pse-2", attemptId: "attempt-1" }),
      );
      assert.ok(Exit.isFailure(duplicated));

      const rows = yield* sql<{ readonly n: number }>`
        SELECT COUNT(*) AS "n" FROM project_skill_observed_uses
      `;
      assert.equal(rows[0]?.n, 1);
    }));
});
