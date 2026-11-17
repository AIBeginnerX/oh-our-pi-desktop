import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 073_ProjectMemoryProposalDreamed.
 *
 * `project_memory_proposals.dreamed` is 1 when a suggestion was filed by the
 * scheduled dreaming run rather than the Analyse action. Only the pending
 * proposal display reads it; existing rows default to 0, so manual-run and
 * agent suggestions look unchanged.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    SELECT name FROM pragma_table_info('project_memory_proposals')
  `;
  if (!columns.some((column) => column.name === "dreamed")) {
    yield* sql`
      ALTER TABLE project_memory_proposals
      ADD COLUMN dreamed INTEGER NOT NULL DEFAULT 0 CHECK (dreamed IN (0, 1))
    `;
  }
});
