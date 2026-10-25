import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Recovery checkpoints. Tool results remain in the orchestration event log. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE crew_tasks (
      task_id TEXT PRIMARY KEY,
      lead_thread_id TEXT NOT NULL,
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_crew_tasks_lead ON crew_tasks (lead_thread_id)
  `;
  yield* sql`
    CREATE TABLE crew_followups (
      delivery_id TEXT PRIMARY KEY,
      lead_thread_id TEXT NOT NULL,
      command_id TEXT NOT NULL UNIQUE,
      message_id TEXT NOT NULL UNIQUE,
      record_json TEXT NOT NULL CHECK (json_valid(record_json)),
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      rejected_at TEXT
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX idx_crew_followups_pending ON crew_followups (lead_thread_id)
    WHERE delivered_at IS NULL AND rejected_at IS NULL
  `;
});
