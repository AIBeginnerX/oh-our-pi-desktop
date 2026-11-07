import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 070_DropUnusedOrchestrationEventIndexes.
 *
 * No production query filters `orchestration_events` by `command_id` or
 * `correlation_id` through an index: command idempotency reads
 * `orchestration_command_receipts`, and event readers use the stream and
 * sequence indexes. The two indexes only cost write amplification and disk.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_correlation_id`;
  yield* sql`DROP INDEX IF EXISTS idx_orch_events_command_id`;
});
