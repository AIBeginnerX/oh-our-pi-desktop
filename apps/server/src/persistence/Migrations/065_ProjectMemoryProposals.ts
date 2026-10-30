import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 065_ProjectMemoryProposals (memories agents propose, pending user review).
 *
 * Proposals get their own table instead of a status column on
 * `project_memories` on purpose: every read, the FTS index and the send
 * ledger see only approved memories, so a pending proposal cannot reach
 * search, the composer or a provider by any path. Approval moves the text
 * into `project_memories`; rejection deletes the row.
 *
 * Like memories, a project's proposals die with the project tombstone.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_proposals (
      proposal_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_memory_proposals_project
    ON project_memory_proposals (project_id, created_at)
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_proposals_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_memory_proposals WHERE project_id = OLD.project_id;
    END
  `;
});
