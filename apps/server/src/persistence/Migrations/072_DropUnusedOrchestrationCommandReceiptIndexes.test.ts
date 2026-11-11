import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

const indexNames = (sql: SqlClient.SqlClient) =>
  sql<{ readonly name: string }>`
    SELECT name FROM pragma_index_list('orchestration_command_receipts') ORDER BY name
  `.pipe(Effect.map((rows) => rows.map((row) => row.name)));

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "072_DropUnusedOrchestrationCommandReceiptIndexes",
  (it) => {
    it.effect("drops unused indexes and preserves primary-key receipt lookup", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 71 });
        const before = yield* indexNames(sql);
        assert.include(before, "idx_orch_command_receipts_aggregate");
        assert.include(before, "idx_orch_command_receipts_sequence");
        yield* sql`
          INSERT INTO orchestration_command_receipts (
            command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, error
          ) VALUES ('cmd-1', 'thread', 'thread-1', '2026-01-01T00:00:00.000Z', 1, 'accepted', NULL)
        `;

        yield* runMigrations({ toMigrationInclusive: 72 });

        const after = yield* indexNames(sql);
        assert.notInclude(after, "idx_orch_command_receipts_aggregate");
        assert.notInclude(after, "idx_orch_command_receipts_sequence");
        assert.include(after, "sqlite_autoindex_orchestration_command_receipts_1");
        const receipts = yield* sql<{ readonly commandId: string; readonly status: string }>`
          SELECT command_id AS "commandId", status FROM orchestration_command_receipts
          WHERE command_id = 'cmd-1'
        `;
        assert.deepEqual(receipts, [{ commandId: "cmd-1", status: "accepted" }]);
      }),
    );
  },
);
