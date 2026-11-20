import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE project_memories ADD COLUMN held INTEGER NOT NULL DEFAULT 0 CHECK (held IN (0, 1))`;
  yield* sql`ALTER TABLE project_memory_send_attempts ADD COLUMN sent_after_event_sequence INTEGER`;
  yield* sql`
    CREATE TABLE project_memory_outcomes (
      project_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      memory_version INTEGER NOT NULL CHECK (memory_version >= 1),
      thread_id TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('good', 'bad', 'unknown')),
      judged_at_event_sequence INTEGER NOT NULL CHECK (judged_at_event_sequence >= 0),
      PRIMARY KEY (project_id, memory_id, memory_version, thread_id)
    )
  `;
  yield* sql`
    CREATE TRIGGER project_memory_outcomes_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_memory_outcomes WHERE project_id = OLD.project_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER project_memory_outcomes_memory_delete
    AFTER DELETE ON project_memories
    BEGIN
      DELETE FROM project_memory_outcomes
      WHERE project_id = OLD.project_id AND memory_id = OLD.memory_id;
    END
  `;
});
