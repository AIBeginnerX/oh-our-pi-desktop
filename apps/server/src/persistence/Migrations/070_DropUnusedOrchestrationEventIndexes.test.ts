import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const indexNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_index_list('orchestration_events') ORDER BY name
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "070_DropUnusedOrchestrationEventIndexes",
  (it) => {
    it.effect("drops the command and correlation indexes and keeps events readable", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 69 });
        const before = yield* indexNames(sql);
        assert.include(before, "idx_orch_events_command_id");
        assert.include(before, "idx_orch_events_correlation_id");
        yield* sql`
          INSERT INTO orchestration_events (
            event_id, aggregate_kind, stream_id, stream_version, event_type,
            occurred_at, command_id, causation_event_id, correlation_id,
            actor_kind, payload_json, metadata_json
          ) VALUES (
            'event-1', 'thread', 'thread-1', 1, 'thread.created',
            '2026-01-01T00:00:00.000Z', 'cmd-1', NULL, 'cmd-1',
            'user', '{}', '{}'
          )
        `;

        yield* runMigrations({ toMigrationInclusive: 70 });

        const after = yield* indexNames(sql);
        assert.notInclude(after, "idx_orch_events_command_id");
        assert.notInclude(after, "idx_orch_events_correlation_id");
        assert.include(after, "idx_orch_events_stream_sequence");
        assert.include(after, "idx_orch_events_stream_version");
        const events = yield* sql<{ readonly eventId: string }>`
          SELECT event_id AS "eventId" FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = 'thread-1' AND sequence > 0
          ORDER BY sequence
        `;
        assert.deepEqual(events, [{ eventId: "event-1" }]);
      }),
    );
  },
);
