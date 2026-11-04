import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 069_ProjectMemoryProposalEvidenceNamed.
 *
 * `project_memory_proposals.evidence_named` is 1 when a suggestion's evidence
 * was chosen because the lesson named the check behind it, 0 when the thread's
 * first signal merely stood in. Only named evidence identifies a lesson, so only
 * it earns an evidence tombstone on rejection; existing rows default to 0.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('project_memory_proposals')
  `;
  if (!columns.some((column) => column.name === "evidence_named")) {
    yield* sql`
      ALTER TABLE project_memory_proposals
      ADD COLUMN evidence_named INTEGER NOT NULL DEFAULT 0 CHECK (evidence_named IN (0, 1))
    `;
  }
});
