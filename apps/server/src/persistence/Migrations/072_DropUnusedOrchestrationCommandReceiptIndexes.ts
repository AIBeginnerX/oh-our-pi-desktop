import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 072_DropUnusedOrchestrationCommandReceiptIndexes.
 *
 * No production query uses either index on `orchestration_command_receipts`:
 * reads are primary-key lookups by `command_id`, and the daily pruner is a
 * bounded full-table sweep either way. Nearly all rows are provider receipts
 * that are never read again after their dispatch settles, so the indexes only
 * cost write amplification and disk.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_aggregate`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_command_receipts_sequence`;
});
