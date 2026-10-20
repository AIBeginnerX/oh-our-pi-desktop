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
const EVIDENCE_JSON = JSON.stringify({
  scope: "managed-procedure/v1",
  deliveredRef: {
    projectId: "project-1",
    skillId: "sk-1",
    version: 1,
    contentSha256: SHA,
  },
  deliveredBlockSha256: "c".repeat(64),
  providerInstanceId: "claude-personal",
  providerSessionId: "native-session-1",
  routeConfigSha256: "d".repeat(64),
});

// One fresh file database per test so migration state and seeded rows never
// leak across cases (same harness as 059).
function withTestDatabase<A, E, R>(effect: Effect.Effect<A, E, R | SqlClient.SqlClient>) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-migration-060-"));
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

// The pre-060 row shape: no managed_send_json column exists yet.
const seedInputLegacy = (input: {
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

// The 060 row shape; the label column is NULL unless supplied — inserts are
// how tests fabricate a labelled row, never a production path.
const seedInput = (input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly projectId?: string;
  readonly skillId?: string;
  readonly delivery?: string;
  readonly driverKind?: string | null;
  readonly managedSendJson?: string | null;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_skill_inputs (
        thread_id, message_id, project_id, skill_id, version, content_sha256,
        input_event_sequence, input_incarnation, admitted_skill_state_seq,
        provider_driver_kind, native_skill_inventory_sha256,
        delivery, delivery_at, window, window_closed_at, uncounted_attempts,
        attempt_token, claimed_at, tombstoned_at, managed_send_json
      )
      VALUES (
        ${input.threadId}, ${input.messageId}, ${input.projectId ?? "project-1"},
        ${input.skillId ?? "sk-1"}, 1, ${SHA}, 20, 5, 0,
        ${input.driverKind ?? null}, NULL,
        ${input.delivery ?? "unknown"},
        ${input.delivery === "provider-accepted" ? NOW : null},
        'open', NULL, 0, 'token-1', ${NOW}, NULL, ${input.managedSendJson ?? null}
      )
    `;
  });

const inputRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly skillId: string | null;
    readonly delivery: string;
    readonly providerDriverKind: string | null;
    readonly window: string;
    readonly attemptToken: string;
    readonly tombstonedAt: string | null;
    readonly managedSendJson: string | null;
  }>`
    SELECT skill_id AS "skillId", delivery AS "delivery",
      provider_driver_kind AS "providerDriverKind", window AS "window",
      attempt_token AS "attemptToken", tombstoned_at AS "tombstonedAt",
      managed_send_json AS "managedSendJson"
    FROM project_skill_inputs
    ORDER BY message_id
  `;
});

describe("060_ProjectSkillManagedSend", () => {
  test("upgrades a 059 database: nullable column, recreated triggers, old rows stay NULL", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 59 });
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* seedInputLegacy({ threadId: "thread-1", messageId: "message-1" });
      yield* seedInputLegacy({
        threadId: "thread-1",
        messageId: "message-2",
        delivery: "provider-accepted",
        driverKind: "claude-code",
      });

      const executed = yield* runMigrations({ toMigrationInclusive: 60 });
      assert.deepEqual(executed, [[60, "ProjectSkillManagedSend"]]);

      // The column exists and every pre-existing row is NULL — no backfill.
      const rows = yield* inputRows;
      assert.equal(rows.length, 2);
      assert.ok(rows.every((row) => row.managedSendJson === null));

      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND name IN (
          'project_skill_inputs_transitions',
          'project_skill_trials_on_version_delete'
        )
        ORDER BY name
      `;
      assert.deepEqual(
        triggers.map((row) => row.name),
        ["project_skill_inputs_transitions", "project_skill_trials_on_version_delete"],
      );

      // Idempotent: a second full run executes nothing.
      assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 60 }), []);
    }));

  test("the settle transition may pin the label exactly once; other writes are refused", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedVersion({ projectId: "project-1", skillId: "sk-1" });
      yield* seedInput({ threadId: "thread-1", messageId: "message-1" });
      yield* seedInput({ threadId: "thread-1", messageId: "message-2" });

      // A raw label write is not a permitted transition on an unknown row.
      const rawWrite = yield* Effect.exit(sql`
        UPDATE project_skill_inputs SET managed_send_json = ${EVIDENCE_JSON}
        WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `);
      assert.ok(Exit.isFailure(rawWrite));

      // The settle-shaped UPDATE is the one assignment slot.
      yield* sql`
        UPDATE project_skill_inputs SET delivery = 'provider-accepted',
          provider_driver_kind = 'claude-code', delivery_at = ${NOW},
          managed_send_json = ${EVIDENCE_JSON}
        WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `;
      let rows = yield* inputRows;
      assert.equal(rows[0]?.managedSendJson, EVIDENCE_JSON);

      // Once pinned it is write-once: no rewrite, no drop, no label on a
      // later ordinary settle, and no post-acceptance enrichment.
      for (const attempt of [
        sql`UPDATE project_skill_inputs SET managed_send_json = '{"scope":"other"}'
            WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
        sql`UPDATE project_skill_inputs SET managed_send_json = NULL
            WHERE thread_id = 'thread-1' AND message_id = 'message-1'`,
      ]) {
        assert.ok(Exit.isFailure(yield* Effect.exit(attempt)));
      }
      yield* sql`
        UPDATE project_skill_inputs SET delivery = 'provider-accepted',
          provider_driver_kind = 'claude-code', delivery_at = ${NOW}
        WHERE thread_id = 'thread-1' AND message_id = 'message-2'
      `;
      const lateLabel = yield* Effect.exit(sql`
        UPDATE project_skill_inputs SET managed_send_json = ${EVIDENCE_JSON}
        WHERE thread_id = 'thread-1' AND message_id = 'message-2'
      `);
      assert.ok(Exit.isFailure(lateLabel));

      rows = yield* inputRows;
      assert.equal(rows[0]?.managedSendJson, EVIDENCE_JSON);
      assert.equal(rows[1]?.delivery, "provider-accepted");
      assert.equal(rows[1]?.managedSendJson, null);
    }));

  test("window closure keeps the label and the delete tombstone purges it", () =>
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
        managedSendJson: EVIDENCE_JSON,
      });

      // The one-shot closure carries the label through untouched.
      yield* sql`
        UPDATE project_skill_inputs SET window = 'closed', window_closed_at = ${NOW},
          uncounted_attempts = 0 WHERE thread_id = 'thread-1' AND message_id = 'message-1'
      `;
      let rows = yield* inputRows;
      assert.equal(rows[0]?.window, "closed");
      assert.equal(rows[0]?.managedSendJson, EVIDENCE_JSON);

      // The version-delete tombstone purges the label with the ref payload;
      // delivery ownership stays.
      yield* sql`DELETE FROM project_skill_versions WHERE skill_id = 'sk-1'`;
      rows = yield* inputRows;
      assert.equal(rows[0]?.skillId, null);
      assert.equal(rows[0]?.managedSendJson, null);
      assert.equal(rows[0]?.delivery, "provider-accepted");
      assert.equal(rows[0]?.providerDriverKind, "claude-code");
      assert.equal(rows[0]?.attemptToken, "token-1");
      assert.equal(rows[0]?.tombstonedAt !== null, true);

      // A hand-shaped tombstone must clear the label in the same write.
      yield* seedVersion({ projectId: "project-1", skillId: "sk-2" });
      yield* seedInput({
        threadId: "thread-1",
        messageId: "message-2",
        skillId: "sk-2",
        delivery: "provider-accepted",
        driverKind: "claude-code",
        managedSendJson: EVIDENCE_JSON,
      });
      const badTombstone = yield* Effect.exit(sql`
        UPDATE project_skill_inputs SET skill_id = NULL, version = NULL,
          content_sha256 = NULL, admitted_skill_state_seq = NULL, tombstoned_at = ${NOW}
        WHERE thread_id = 'thread-1' AND message_id = 'message-2'
      `);
      assert.ok(Exit.isFailure(badTombstone));
      yield* sql`
        UPDATE project_skill_inputs SET skill_id = NULL, version = NULL,
          content_sha256 = NULL, admitted_skill_state_seq = NULL,
          managed_send_json = NULL, tombstoned_at = ${NOW}
        WHERE thread_id = 'thread-1' AND message_id = 'message-2'
      `;
      rows = yield* inputRows;
      assert.equal(rows[1]?.managedSendJson, null);
      assert.equal(rows[1]?.attemptToken, "token-1");
    }));
});
