import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 068_ProjectMemoryDerivedProposals (work-analyser suggestions).
 *
 * - `project_memory_proposals` gains `source` ('agent' | 'analyser') so the
 *   two kinds are capped separately, `target` ('memory' | 'skill') for a
 *   procedure nominated as a skill-draft source, and the evidence and
 *   related-memory columns an analyser suggestion carries.
 * - `project_memories.origin_evidence_json` marks a memory as derived. The
 *   `origin_type` CHECK from 056 cannot be widened without rebuilding the
 *   table and its FTS triggers, so a derived memory keeps `origin_type =
 *   'manual'` (no source message) and is told apart by the evidence column.
 * - `project_memory_tombstones` keeps the hash of a rejected suggestion's
 *   normalized text, never the text, so the analyser does not propose it
 *   again. Tombstones die with the project, like memories.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const addColumn = (table: string, column: string, definition: string) =>
    Effect.gen(function* () {
      const columns = yield* sql<{ readonly name: string }>`
        SELECT name FROM pragma_table_info(${table})
      `;
      if (!columns.some((existing) => existing.name === column)) {
        yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      }
    });

  yield* addColumn("project_memories", "origin_evidence_json", "TEXT");
  yield* addColumn(
    "project_memory_proposals",
    "source",
    "TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('agent', 'analyser'))",
  );
  yield* addColumn(
    "project_memory_proposals",
    "target",
    "TEXT NOT NULL DEFAULT 'memory' CHECK (target IN ('memory', 'skill'))",
  );
  yield* addColumn("project_memory_proposals", "evidence_json", "TEXT");
  yield* addColumn("project_memory_proposals", "related_memory_ids_json", "TEXT");

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_tombstones (
      project_id TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, body_hash)
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_tombstones_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_memory_tombstones WHERE project_id = OLD.project_id;
    END
  `;
});
