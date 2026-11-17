import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE project_memory_tidy_suggestions (
    tidy_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('merge', 'update', 'delete')),
    title TEXT, body TEXT, reason TEXT NOT NULL, memories_json TEXT NOT NULL,
    dreamed INTEGER NOT NULL CHECK (dreamed IN (0, 1)), created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX idx_project_memory_tidy_project ON project_memory_tidy_suggestions(project_id, created_at)`;
  yield* sql`CREATE TRIGGER project_memory_tidy_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_memory_tidy_suggestions WHERE project_id = OLD.project_id;
    END`;
  yield* sql`ALTER TABLE project_memory_analysis_cursors ADD COLUMN tidy_fingerprint TEXT`;
});
