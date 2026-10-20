import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 058_ProjectSkills (S2: inactive project-skill candidate storage).
 *
 * - `project_skill_versions` holds one row per skill version. The version
 *   identity is the four-field ref (project_id, skill_id, version,
 *   content_sha256); UNIQUE (skill_id, version) and UNIQUE (skill_id,
 *   content_sha256) close the two insert races the repository guards.
 *   `content_json` is the ProjectSkillContent encoding. `source_json` is the
 *   ProjectSkillSource encoding minus only its top-level
 *   `createdAfterEventSequence`, which lives in its own column — that W is
 *   MAX(orchestration_events.sequence) measured inside the insert statement,
 *   so it compares against receipt sequences, anchors, and input events in
 *   the same event sequence space. `source_thread_id`,
 *   `source_receipt_sequence`, and `source_thread_created_sequence` pin the
 *   root work lineage's thread, its receipt write, and the thread
 *   incarnation that receipt ran in; revisions copy them unchanged.
 * - `state`/`retired_reason` are the only mutable columns and this slice has
 *   no writer for either — rows are created `candidate`. The immutability
 *   trigger freezes identity, content, provenance, and timestamps; a later
 *   slice owns the state transitions.
 * - `project_skill_judgments` is append-only: a row is inserted against one
 *   exact full ref and the only permitted update moves `withdrawn_at` from
 *   NULL to a value with every other column unchanged. Withdrawal is one-way
 *   and never edits the judgment content.
 * - `project_skill_project_tombstone` mirrors 056: tombstoning a project
 *   (deleted_at NULL -> non-NULL) deletes both tables' rows for it inside
 *   the same statement's transaction. Raw projection deletes and thread
 *   tombstones deliberately keep rows — every repository read and write
 *   re-checks project liveness, so a raw delete can only orphan data, never
 *   expose or mutate it. Un-tombstoning a project does not restore skills.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_skill_versions (
      version_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      content_json TEXT NOT NULL,
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      source_json TEXT NOT NULL,
      source_thread_id TEXT NOT NULL,
      source_receipt_sequence INTEGER NOT NULL,
      source_thread_created_sequence INTEGER NOT NULL,
      created_after_event_sequence INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'candidate' CHECK (state IN ('candidate', 'active', 'retired')),
      retired_reason TEXT CHECK (
        retired_reason IS NULL
        OR retired_reason IN (
          'superseded',
          'user-retired',
          'environment-changed',
          'failed-in-use',
          'rejected'
        )
      ),
      created_at TEXT NOT NULL,
      UNIQUE (skill_id, version),
      UNIQUE (skill_id, content_sha256)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_skill_versions_project
    ON project_skill_versions (project_id, skill_id, version)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_skill_judgments (
      judgment_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      content_sha256 TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (
        kind IN (
          'rights',
          'review',
          'reproduction',
          'non-application',
          'interference',
          'failure-classification'
        )
      ),
      judgment_json TEXT NOT NULL,
      recorded_after_event_sequence INTEGER NOT NULL,
      withdrawn_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_skill_judgments_ref
    ON project_skill_judgments (skill_id, version, content_sha256)
  `;

  // Identity, content, provenance, and timestamps never change after insert;
  // state/retired_reason stay updatable for the later activation slice.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_versions_immutable
    BEFORE UPDATE OF
      skill_id, project_id, version, content_json, content_sha256,
      source_json, source_thread_id, source_receipt_sequence,
      source_thread_created_sequence, created_after_event_sequence, created_at
    ON project_skill_versions
    BEGIN
      SELECT RAISE(ABORT, 'project_skill_versions identity, content, and provenance are immutable');
    END
  `;

  // Withdrawal is the only judgment transition: withdrawn_at NULL -> non-NULL
  // with every other column null-safe identical. Anything else aborts.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_judgments_append_only
    BEFORE UPDATE ON project_skill_judgments
    FOR EACH ROW
    WHEN NOT (
      OLD.withdrawn_at IS NULL
      AND NEW.withdrawn_at IS NOT NULL
      AND OLD.judgment_id IS NEW.judgment_id
      AND OLD.project_id IS NEW.project_id
      AND OLD.skill_id IS NEW.skill_id
      AND OLD.version IS NEW.version
      AND OLD.content_sha256 IS NEW.content_sha256
      AND OLD.kind IS NEW.kind
      AND OLD.judgment_json IS NEW.judgment_json
      AND OLD.recorded_after_event_sequence IS NEW.recorded_after_event_sequence
    )
    BEGIN
      SELECT RAISE(ABORT, 'project_skill_judgments only permits withdrawn_at NULL to non-NULL');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_project_tombstone
    AFTER UPDATE OF deleted_at ON projection_projects
    WHEN NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
    BEGIN
      DELETE FROM project_skill_judgments WHERE project_id = OLD.project_id;
      DELETE FROM project_skill_versions WHERE project_id = OLD.project_id;
    END
  `;
});
