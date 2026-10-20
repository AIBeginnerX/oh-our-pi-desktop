import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per safety event the provider reported, written before the event reaches the
  // projection. A row with no matching activity is work the projection never saw. `turn_id` stays
  // NULL when the event had none, and `observed_at` is diagnostic only. No foreign key: a failed
  // constraint would drop the observation, so the triggers below own the lifecycle instead.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_safety_observations (
      thread_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      turn_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('tool.started', 'approval.requested', 'user-input.requested')),
      observed_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, event_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pso_thread_turn
    ON provider_safety_observations(thread_id, turn_id)
  `;

  // Tombstone, un-tombstone and hard delete each clear the thread's rows; un-tombstoning also
  // clears inserts that landed after the tombstone. There is deliberately no insert trigger, which
  // could delete a current observation.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_pso_thread_tombstoned
    AFTER UPDATE OF deleted_at ON projection_threads
    WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
    BEGIN
      DELETE FROM provider_safety_observations WHERE thread_id = NEW.thread_id;
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_pso_thread_recreated
    AFTER UPDATE OF deleted_at ON projection_threads
    WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
    BEGIN
      DELETE FROM provider_safety_observations WHERE thread_id = NEW.thread_id;
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS trg_pso_thread_deleted
    AFTER DELETE ON projection_threads
    BEGIN
      DELETE FROM provider_safety_observations WHERE thread_id = OLD.thread_id;
    END
  `;
});
