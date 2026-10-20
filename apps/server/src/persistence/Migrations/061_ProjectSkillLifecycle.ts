import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 061_ProjectSkillLifecycle (C2: activation lifecycle constraints and
 * durable scoped holds — no RPC surface, no gate).
 *
 * - `project_skill_one_active_per_project` enforces at most one `active`
 *   version row per project. The repository's transition writer carries the
 *   intended-post-switch rule transactionally (only the superseded version
 *   of the same skill may leave `active`); this partial index is the floor
 *   a raced or future writer cannot pass.
 * - `project_skill_holds` is the append-only scoped-hold table: one row per
 *   (exact full ref, evidence identity, kind). The ref, the observed-use
 *   evidence identity (thread_id, message_id, attempt_id), and the evidence
 *   scope are columns so reads and purges are structural; `hold_json` is
 *   the full `ProjectSkillHold` encoding. UNIQUE (ref..., evidence..., kind)
 *   makes the failed-use sweep idempotent. Updates are prohibited — a
 *   release is derived from judgments and reproductions, never written.
 * - Judgment inserts, the one-way withdrawal, and hold inserts all bump the
 *   project's state sequence, so an admission stamped earlier is
 *   invalidated. The 059 version-state and version-delete triggers stay as
 *   they are; this migration adds none for version rows.
 * - Version DELETE (including the 058 project-tombstone cascade) purges the
 *   ref's holds alongside 059's observation purge. Trials input ownership
 *   tombstones are untouched: delivery ownership and the attempt token are
 *   preserved by the same 060 tombstone write as before.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS project_skill_one_active_per_project
    ON project_skill_versions (project_id)
    WHERE state = 'active'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_skill_holds (
      hold_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      kind TEXT NOT NULL CHECK (kind IN ('failure-observed', 'environment-changed')),
      evidence_scope TEXT CHECK (
        evidence_scope IS NULL
        OR evidence_scope IN ('native-inventory', 'managed-procedure/v1')
      ),
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      observed_at_event_sequence INTEGER NOT NULL CHECK (observed_at_event_sequence >= 0),
      hold_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS project_skill_holds_evidence_kind
    ON project_skill_holds (
      project_id, skill_id, version, content_sha256,
      thread_id, message_id, attempt_id, kind
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_skill_holds_ref
    ON project_skill_holds (skill_id, version, content_sha256)
  `;

  // Holds are append-only evidence: release is derived, never written, and
  // only the version-delete purge may remove a row.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_holds_append_only
    BEFORE UPDATE ON project_skill_holds
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'project_skill_holds rows are immutable');
    END
  `;

  // A deleted version's holds go with its observations (059); a project
  // tombstone reaches this trigger through the 058 cascade.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_holds_on_version_delete
    AFTER DELETE ON project_skill_versions
    FOR EACH ROW
    BEGIN
      DELETE FROM project_skill_holds
      WHERE project_id = OLD.project_id
        AND skill_id = OLD.skill_id
        AND version = OLD.version
        AND content_sha256 = OLD.content_sha256;
    END
  `;

  // Every admission-visible write bumps the project state sequence so an
  // admission stamped earlier is invalidated: judgment inserts, the one-way
  // withdrawal, and hold inserts all count.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_state_on_judgment_insert
    AFTER INSERT ON project_skill_judgments
    FOR EACH ROW
    BEGIN
      INSERT INTO project_skill_state (project_id, seq) VALUES (NEW.project_id, 1)
        ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1;
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_state_on_judgment_withdraw
    AFTER UPDATE OF withdrawn_at ON project_skill_judgments
    FOR EACH ROW
    WHEN OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
    BEGIN
      INSERT INTO project_skill_state (project_id, seq) VALUES (NEW.project_id, 1)
        ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1;
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_state_on_hold_insert
    AFTER INSERT ON project_skill_holds
    FOR EACH ROW
    BEGIN
      INSERT INTO project_skill_state (project_id, seq) VALUES (NEW.project_id, 1)
        ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1;
    END
  `;
});
