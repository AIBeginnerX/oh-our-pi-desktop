import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "./Migrations.ts";

it.effect("upgrades the memory schema from 075 and removes outcome evidence on tombstone", () =>
  Effect.gen(function* () {
    yield* runMigrations({ toMigrationInclusive: 75 });
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-10-09T00:00:00.000Z";
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('p', 'Project', '/tmp/project', '[]', ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO project_memory_send_attempts (
        thread_id, message_id, project_id, provider_instance_id, owner_instance_id,
        state, committed_at
      ) VALUES ('t', 'msg', 'p', 'provider', 'owner', 'provider_accepted', ${now})
    `;
    assert.deepEqual(yield* runMigrations({ toMigrationInclusive: 76 }), [
      [76, "ProjectMemoryOutcomes"],
    ]);
    assert.deepEqual(
      yield* sql`SELECT sent_after_event_sequence FROM project_memory_send_attempts`,
      [{ sent_after_event_sequence: null }],
    );
    yield* sql`
      INSERT INTO project_memory_outcomes
        (project_id, memory_id, memory_version, thread_id, outcome, judged_at_event_sequence)
      VALUES ('p', 'm', 1, 't', 'good', 2)
    `;
    yield* sql`UPDATE projection_projects SET deleted_at = ${now} WHERE project_id = 'p'`;
    assert.deepEqual(yield* sql`SELECT outcome FROM project_memory_outcomes`, []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
