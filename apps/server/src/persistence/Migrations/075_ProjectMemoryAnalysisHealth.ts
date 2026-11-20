import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 075_ProjectMemoryAnalysisHealth (what the work analyser's last run came to).
 *
 * One row per project, replaced by each run: when it was attempted, when a run last finished
 * without error, how many threads it read and how many carried a signal, how many candidates the
 * model returned and how many were filed, and the outcome. It explains an empty suggestions list.
 * Counts and an outcome only, never text from the work. Dies with the project tombstone, like the
 * analysis cursor.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_analysis_health (
      project_id TEXT PRIMARY KEY,
      last_attempt_at TEXT NOT NULL,
      last_success_at TEXT,
      threads_read INTEGER NOT NULL CHECK (threads_read >= 0),
      threads_with_signals INTEGER NOT NULL CHECK (threads_with_signals >= 0),
      candidates_returned INTEGER NOT NULL CHECK (candidates_returned >= 0),
      suggestions_filed INTEGER NOT NULL CHECK (suggestions_filed >= 0),
      outcome TEXT NOT NULL CHECK (outcome IN ('proposed', 'no-signals', 'no-candidates', 'queue-full', 'failed'))
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_analysis_health_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_memory_analysis_health WHERE project_id = OLD.project_id;
    END
  `;
});
