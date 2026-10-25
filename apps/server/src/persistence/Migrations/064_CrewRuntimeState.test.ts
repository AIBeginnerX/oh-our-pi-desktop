import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../Layers/Sqlite.ts";

describe("Crew recovery schema", () => {
  it.effect("keeps an undelivered follow-up with stable dispatch identities", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO crew_tasks (task_id, lead_thread_id, record_json, updated_at)
        VALUES ('task-1', 'lead-1', '{"collected":false}', '2026-10-24T00:00:00.000Z')
      `;
      yield* sql`
        INSERT INTO crew_followups (
          delivery_id, lead_thread_id, command_id, message_id, record_json, created_at
        )
        VALUES (
          'delivery-1', 'lead-1', 'command-1', 'message-1',
          '{"taskIds":["task-1"]}', '2026-10-24T00:00:00.000Z'
        )
      `;
      const pending = yield* sql<{
        readonly command_id: string;
        readonly message_id: string;
        readonly record_json: string;
      }>`
        SELECT command_id, message_id, record_json FROM crew_followups
        WHERE lead_thread_id = 'lead-1' AND delivered_at IS NULL
      `;
      assert.deepEqual(pending, [
        {
          command_id: "command-1",
          message_id: "message-1",
          record_json: '{"taskIds":["task-1"]}',
        },
      ]);
      yield* sql`
        UPDATE crew_followups SET delivered_at = '2026-10-24T00:00:01.000Z'
        WHERE delivery_id = 'delivery-1'
      `;
      const after = yield* sql`
        SELECT delivery_id FROM crew_followups WHERE delivered_at IS NULL
      `;
      assert.equal(after.length, 0);
      const retained = yield* sql`
        SELECT delivery_id FROM crew_followups WHERE delivery_id = 'delivery-1'
      `;
      assert.equal(retained.length, 1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );

  it.effect("rejects ambiguous dispatch identities and malformed checkpoints", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO crew_followups (
          delivery_id, lead_thread_id, command_id, message_id, record_json, created_at
        )
        VALUES ('delivery-1', 'lead-1', 'command-1', 'message-1', '{}', '2026-10-24')
      `;
      const duplicate = yield* sql`
        INSERT INTO crew_followups (
          delivery_id, lead_thread_id, command_id, message_id, record_json, created_at
        )
        VALUES ('delivery-2', 'lead-1', 'command-1', 'message-2', '{}', '2026-10-24')
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(duplicate));
      const malformed = yield* sql`
        INSERT INTO crew_tasks (task_id, lead_thread_id, record_json, updated_at)
        VALUES ('task-1', 'lead-1', 'not-json', '2026-10-24')
      `.pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(malformed));
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
  );
});
