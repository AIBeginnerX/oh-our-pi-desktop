import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 057_ProjectMemorySendLedger (T5b-0: project memory send ledger, storage only).
 *
 * - **No text.** These ledger tables contain no memory title/body snapshots —
 *   only ids, versions, states, and timestamps.
 * - **No foreign keys, deliberately.** Cleanup FKs would cascade-delete exposure
 *   evidence when a memory, message, or project row disappears. Ledger rows
 *   outlive the rows they reference.
 * - **No thread-cleanup trigger.** This ledger conservatively records across a
 *   thread id's whole lifetime. It does not try to distinguish the current
 *   session or incarnation; a recreated thread id keeps its history.
 * - **A failed affected-row INSERT can roll back a project tombstone.** The
 *   affected triggers chain under migration 056's project-tombstone trigger, so
 *   an affected INSERT failure atomically aborts the memory deletion and the
 *   tombstone update that caused it. That is intended: the failure is retryable
 *   and must never be swallowed or bypassed.
 * - **Finality protection has limits.** Supported API transitions are the only
 *   legitimate way to settle an attempt. Raw DELETEs or dropping the triggers
 *   can still tamper — this is not a tamper-proof device.
 *
 * States: `dispatch_committed` -> `provider_accepted` | `external_send_unknown`.
 * The two final states never transition between each other.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_send_attempts (
      attempt_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL, message_id TEXT NOT NULL, project_id TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      owner_instance_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('dispatch_committed','provider_accepted','external_send_unknown')),
      committed_at TEXT NOT NULL, settled_at TEXT,
      UNIQUE (thread_id, message_id)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_send_items (
      attempt_seq INTEGER NOT NULL, memory_id TEXT NOT NULL,
      memory_version INTEGER NOT NULL CHECK (memory_version >= 1),
      PRIMARY KEY (attempt_seq, memory_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pm_send_items_memory ON project_memory_send_items (memory_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_affected (
      change_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL, memory_id TEXT NOT NULL,
      reason TEXT NOT NULL CHECK (reason IN ('updated','deleted')),
      changed_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pm_affected_thread ON project_memory_affected (thread_id, change_seq)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memory_thread_acks (
      thread_id TEXT PRIMARY KEY,
      acked_through_change_seq INTEGER NOT NULL CHECK (acked_through_change_seq >= 0)
    )
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_affected_on_update AFTER UPDATE ON project_memories
    BEGIN
      INSERT INTO project_memory_affected (thread_id, memory_id, reason, changed_at)
      SELECT DISTINCT a.thread_id, OLD.memory_id, 'updated', strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM project_memory_send_items i JOIN project_memory_send_attempts a ON a.attempt_seq = i.attempt_seq
      WHERE i.memory_id = OLD.memory_id;
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_affected_on_delete AFTER DELETE ON project_memories
    BEGIN
      INSERT INTO project_memory_affected (thread_id, memory_id, reason, changed_at)
      SELECT DISTINCT a.thread_id, OLD.memory_id, 'deleted', strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM project_memory_send_items i JOIN project_memory_send_attempts a ON a.attempt_seq = i.attempt_seq
      WHERE i.memory_id = OLD.memory_id;
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_send_attempt_final BEFORE UPDATE ON project_memory_send_attempts
    WHEN OLD.state <> 'dispatch_committed'
      OR NEW.state NOT IN ('provider_accepted','external_send_unknown')
      OR NEW.thread_id IS NOT OLD.thread_id OR NEW.message_id IS NOT OLD.message_id
      OR NEW.project_id IS NOT OLD.project_id OR NEW.provider_instance_id IS NOT OLD.provider_instance_id
      OR NEW.owner_instance_id IS NOT OLD.owner_instance_id OR NEW.committed_at IS NOT OLD.committed_at
    BEGIN SELECT RAISE(ABORT, 'project memory send attempt is final'); END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memory_send_items_immutable BEFORE UPDATE ON project_memory_send_items
    BEGIN SELECT RAISE(ABORT, 'project memory send item is immutable'); END
  `;
});
