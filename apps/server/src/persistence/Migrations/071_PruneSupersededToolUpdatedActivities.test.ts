import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))(
  "071_PruneSupersededToolUpdatedActivities",
  (it) => {
    it.effect("removes updates a later completion of the same call supersedes", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 70 });
        const put = (
          id: string,
          turn: string | null,
          kind: string,
          payload: string,
          sequence: number | null,
          thread = "thread-1",
        ) => sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          ) VALUES (
            ${id}, ${thread}, ${turn}, 'tool', ${kind}, 'Tool', ${payload}, ${sequence},
            '2026-01-01T00:00:00.000Z'
          )
        `;
        // Call A completes: both earlier updates go, the later one (a reused id) stays.
        yield* put("a-update-1", "turn-1", "tool.updated", '{"toolCallId":"A"}', 1);
        yield* put("a-update-nested", "turn-1", "tool.updated", '{"data":{"toolCallId":"A"}}', 2);
        yield* put("a-complete", "turn-1", "tool.completed", '{"toolCallId":"A"}', 3);
        yield* put("a-update-after", "turn-1", "tool.updated", '{"toolCallId":"A"}', 4);
        // Same id in another turn, another thread, and an in-flight call stay.
        yield* put("a-other-turn", "turn-2", "tool.updated", '{"toolCallId":"A"}', 1);
        yield* put("a-other-thread", "turn-1", "tool.updated", '{"toolCallId":"A"}', 1, "thread-2");
        yield* put("b-update", "turn-1", "tool.updated", '{"toolCallId":"B"}', 5);
        // No toolCallId: left for the read-path filter. Malformed JSON must not fail the migration.
        yield* put("no-id-update", null, "tool.updated", '{"title":"Run"}', null);
        yield* put("no-id-complete", null, "tool.completed", '{"title":"Run"}', 6);
        yield* put("bad-json", "turn-1", "tool.updated", "{not-json", 7);

        yield* runMigrations({ toMigrationInclusive: 71 });

        const rows = yield* sql<{ readonly id: string }>`
          SELECT activity_id AS "id" FROM projection_thread_activities ORDER BY activity_id
        `;
        assert.deepEqual(
          rows.map((row) => row.id),
          [
            "a-complete",
            "a-other-thread",
            "a-other-turn",
            "a-update-after",
            "b-update",
            "bad-json",
            "no-id-complete",
            "no-id-update",
          ],
        );
      }),
    );
  },
);
