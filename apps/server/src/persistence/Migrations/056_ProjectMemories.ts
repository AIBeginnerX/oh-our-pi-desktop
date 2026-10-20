import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 056_ProjectMemories (T5a: project memory storage and management).
 *
 * - `project_memories` holds project-scoped memory rows. `title`/`body` live
 *   only in this table and the FTS index — never in events, projections,
 *   activity, or provider context. `version` backs strict optimistic
 *   concurrency; `origin_*` records server-verified same-project provenance.
 * - `project_memory_fts` is a contentless-delete trigram index over
 *   (title, body) keyed to `project_memories.memory_rowid`. Contentless means
 *   the index stores no copy of the original columns — but it does retain the
 *   derived trigram postings, so deleting a memory row without deleting its
 *   index row leaves the old terms searchable forever. Every row mutation
 *   therefore removes the index row with an ordinary `DELETE` in the same
 *   transaction (or the same trigger). The `secure-delete` FTS5 option below
 *   shrinks the deletion traces inside the index itself; it is not a byte-level
 *   erasure guarantee for WAL, freelist pages, or backups.
 * - `project_memories_project_tombstone` fires only when a project row is
 *   tombstoned (`deleted_at` NULL -> non-NULL), deleting that project's
 *   memories and index rows inside the same statement's transaction. There is
 *   deliberately no trigger on `projection_projects` DELETE: projection
 *   rebuilds and raw deletes must never wipe user fact data — a raw delete
 *   just orphans rows that reads hide behind the live-project check.
 *   Un-tombstoning a project does not bring memories back.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_memories (
      memory_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact', 'procedure', 'work-log')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      origin_type TEXT NOT NULL CHECK (origin_type IN ('manual', 'message')),
      origin_thread_id TEXT,
      origin_message_id TEXT,
      valid_until TEXT,
      estimated_tokens INTEGER NOT NULL CHECK (estimated_tokens >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (memory_id),
      CHECK (
        (origin_type = 'manual' AND origin_thread_id IS NULL AND origin_message_id IS NULL)
        OR (origin_type = 'message' AND origin_thread_id IS NOT NULL AND origin_message_id IS NOT NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_memories_project
    ON project_memories (project_id, updated_at, memory_rowid)
  `;

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS project_memory_fts USING fts5(
      title,
      body,
      content='',
      contentless_delete=1,
      tokenize='trigram'
    )
  `;

  // Persisted in project_memory_fts_config; running it again is harmless.
  // Makes deletions remove the posting traces the index would otherwise keep,
  // within the limits described above.
  yield* sql`
    INSERT INTO project_memory_fts (project_memory_fts, rank)
    VALUES ('secure-delete', 1)
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_memories_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_memory_fts
      WHERE rowid IN (
        SELECT memory_rowid FROM project_memories WHERE project_id = OLD.project_id
      );
      DELETE FROM project_memories
      WHERE project_id = OLD.project_id;
    END
  `;
});
