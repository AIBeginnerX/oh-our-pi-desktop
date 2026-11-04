import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 067_ProjectMemoryAnalysisCursor (where the work analyser stopped reading).
 *
 * The work digest is derived from retained orchestration events and stored
 * nowhere. The only thing kept is, per project, the highest event sequence an
 * analysis run has covered, so the next run looks at threads with newer
 * events. The cursor only moves forward and dies with the project tombstone,
 * like memories.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_analysis_cursors (
      project_id TEXT PRIMARY KEY,
      last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_analysis_cursors_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_memory_analysis_cursors WHERE project_id = OLD.project_id;
    END
  `;
});
