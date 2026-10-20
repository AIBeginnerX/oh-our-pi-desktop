import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 059_ProjectSkillTrials (S4a: trial delivery ownership and observation
 * storage — no gate, no activation writer).
 *
 * - `project_skill_state` is one monotonically growing sequence per project.
 *   Every version state/retired_reason change and every version delete bumps
 *   it (a no-op UPDATE that writes identical values does not). Admission
 *   stamps this value as the input's `admitted_skill_state_seq`; the delivery
 *   claim later proves nothing moved in between. The 058 immutability trigger
 *   still owns the versions themselves — content and provenance never change,
 *   and this slice still has no activation writer for `state`.
 * - `project_skill_inputs` is the delivery-ownership record for one accepted
 *   trial input. The key is (thread_id, message_id); the binding is the
 *   canonical accepted user-message event — `input_event_sequence` is that
 *   committed `thread.message-sent` row's sequence and `input_incarnation`
 *   the `thread.created` sequence governing it — never a turn-request or
 *   replay sequence. `native_skill_inventory_sha256` is CHECK-constrained to
 *   NULL for this slice: null is the truthful "unconfirmed" value, never an
 *   empty digest. `attempt_token` is the settlement ownership secret; reads
 *   that hand it out authorize settlement, so no-resend replies must never
 *   select it. The transitions trigger permits exactly three changes —
 *   delivery unknown -> provider-accepted (with the routed driver kind and a
 *   delivery time), window open -> closed|thread-recreated (carrying the one
 *   computed `uncounted_attempts` total), and the delete tombstone. Nothing
 *   else updates a row, and nothing ever deletes one.
 * - `project_skill_observed_uses` is append-only immutable evidence for one
 *   (thread, message, attempt): written once when the window closes, from the
 *   latest authenticated receipt in the frozen range. Updates abort.
 * - Version DELETE (including the 058 project-tombstone cascade) purges the
 *   ref's observation evidence and reduces its input rows to payload-free
 *   tombstones — ref and admitted stamp drop to NULL — while keeping the
 *   delivery ownership row, so a replayed accepted user message can never
 *   claim a second provider call after a skill delete/recreate. Raw DELETEs
 *   or dropping the triggers can still tamper; this is not a tamper-proof
 *   device (057's convention).
 * - No foreign keys, deliberately (057's convention): ledger-style rows
 *   outlive the rows they reference, and every repository read re-checks
 *   project liveness instead.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_skill_state (
      project_id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL CHECK (seq >= 0)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_skill_inputs (
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      skill_id TEXT,
      version INTEGER CHECK (version IS NULL OR version >= 1),
      content_sha256 TEXT CHECK (content_sha256 IS NULL OR length(content_sha256) = 64),
      input_event_sequence INTEGER NOT NULL CHECK (input_event_sequence >= 0),
      input_incarnation INTEGER NOT NULL CHECK (input_incarnation >= 0),
      admitted_skill_state_seq INTEGER CHECK (admitted_skill_state_seq IS NULL OR admitted_skill_state_seq >= 0),
      provider_driver_kind TEXT,
      native_skill_inventory_sha256 TEXT CHECK (native_skill_inventory_sha256 IS NULL),
      delivery TEXT NOT NULL CHECK (delivery IN ('unknown', 'provider-accepted')),
      delivery_at TEXT CHECK (
        (delivery = 'provider-accepted') = (delivery_at IS NOT NULL)
        AND (delivery = 'provider-accepted') = (provider_driver_kind IS NOT NULL)
      ),
      window TEXT NOT NULL DEFAULT 'open' CHECK (window IN ('open', 'closed', 'thread-recreated')),
      window_closed_at TEXT CHECK ((window = 'open') = (window_closed_at IS NULL)),
      uncounted_attempts INTEGER NOT NULL DEFAULT 0 CHECK (uncounted_attempts >= 0),
      attempt_token TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      tombstoned_at TEXT,
      PRIMARY KEY (thread_id, message_id),
      CHECK (
        (skill_id IS NULL) = (version IS NULL)
        AND (skill_id IS NULL) = (content_sha256 IS NULL)
        AND (skill_id IS NULL) = (admitted_skill_state_seq IS NULL)
      )
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_skill_inputs_ref
    ON project_skill_inputs (project_id, skill_id, version, content_sha256)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS project_skill_observed_uses (
      evidence_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      skill_id TEXT NOT NULL,
      version INTEGER NOT NULL CHECK (version >= 1),
      content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
      check_json TEXT NOT NULL,
      receipt_sequence INTEGER NOT NULL CHECK (receipt_sequence >= 0),
      outcome TEXT NOT NULL CHECK (outcome IN ('all-selected-passed', 'failed')),
      ended_at TEXT,
      recorded_at TEXT NOT NULL,
      UNIQUE (thread_id, message_id, attempt_id)
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_project_skill_observed_uses_ref
    ON project_skill_observed_uses (skill_id, version, content_sha256)
  `;

  // State and retired_reason are the only mutable version columns (058), and
  // their real transitions are the state-sequence events. An UPDATE that
  // writes identical values changes nothing and must not bump.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_state_on_version_state
    AFTER UPDATE OF state, retired_reason ON project_skill_versions
    FOR EACH ROW
    WHEN NEW.state IS NOT OLD.state OR NEW.retired_reason IS NOT OLD.retired_reason
    BEGIN
      INSERT INTO project_skill_state (project_id, seq) VALUES (OLD.project_id, 1)
        ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1;
    END
  `;

  // Deleting a version (raw or through the 058 project-tombstone cascade)
  // bumps the sequence, purges the ref's observation evidence, and reduces
  // its input rows to payload-free delivery tombstones in one row action.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_trials_on_version_delete
    AFTER DELETE ON project_skill_versions
    FOR EACH ROW
    BEGIN
      INSERT INTO project_skill_state (project_id, seq) VALUES (OLD.project_id, 1)
        ON CONFLICT(project_id) DO UPDATE SET seq = seq + 1;
      DELETE FROM project_skill_observed_uses
        WHERE skill_id = OLD.skill_id AND version = OLD.version
          AND content_sha256 = OLD.content_sha256;
      UPDATE project_skill_inputs
        SET skill_id = NULL, version = NULL, content_sha256 = NULL,
          admitted_skill_state_seq = NULL,
          tombstoned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE skill_id = OLD.skill_id AND version = OLD.version
          AND content_sha256 = OLD.content_sha256;
    END
  `;

  // The only permitted transitions: delivery settle, one-shot window closure
  // carrying the computed uncounted total, and the delete tombstone. Identity
  // columns, the canonical input binding, and the ownership token never move.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_inputs_transitions
    BEFORE UPDATE ON project_skill_inputs
    FOR EACH ROW
    WHEN NOT (
      OLD.thread_id IS NEW.thread_id
      AND OLD.message_id IS NEW.message_id
      AND OLD.project_id IS NEW.project_id
      AND OLD.input_event_sequence IS NEW.input_event_sequence
      AND OLD.input_incarnation IS NEW.input_incarnation
      AND OLD.attempt_token IS NEW.attempt_token
      AND OLD.claimed_at IS NEW.claimed_at
      AND OLD.native_skill_inventory_sha256 IS NEW.native_skill_inventory_sha256
      AND (
        (
          OLD.delivery = 'unknown' AND NEW.delivery = 'provider-accepted'
          AND NEW.delivery_at IS NOT NULL AND NEW.provider_driver_kind IS NOT NULL
          AND OLD.skill_id IS NEW.skill_id AND OLD.version IS NEW.version
          AND OLD.content_sha256 IS NEW.content_sha256
          AND OLD.admitted_skill_state_seq IS NEW.admitted_skill_state_seq
          AND OLD.window IS NEW.window AND OLD.window_closed_at IS NEW.window_closed_at
          AND OLD.uncounted_attempts IS NEW.uncounted_attempts
          AND OLD.tombstoned_at IS NEW.tombstoned_at
        )
        OR (
          OLD.window = 'open' AND NEW.window IN ('closed', 'thread-recreated')
          AND NEW.window_closed_at IS NOT NULL
          AND NEW.uncounted_attempts >= OLD.uncounted_attempts
          AND OLD.delivery IS NEW.delivery AND OLD.delivery_at IS NEW.delivery_at
          AND OLD.provider_driver_kind IS NEW.provider_driver_kind
          AND OLD.skill_id IS NEW.skill_id AND OLD.version IS NEW.version
          AND OLD.content_sha256 IS NEW.content_sha256
          AND OLD.admitted_skill_state_seq IS NEW.admitted_skill_state_seq
          AND OLD.tombstoned_at IS NEW.tombstoned_at
        )
        OR (
          OLD.skill_id IS NOT NULL AND NEW.skill_id IS NULL
          AND NEW.version IS NULL AND NEW.content_sha256 IS NULL
          AND NEW.admitted_skill_state_seq IS NULL
          AND NEW.tombstoned_at IS NOT NULL
          AND OLD.delivery IS NEW.delivery AND OLD.delivery_at IS NEW.delivery_at
          AND OLD.provider_driver_kind IS NEW.provider_driver_kind
          AND OLD.window IS NEW.window AND OLD.window_closed_at IS NEW.window_closed_at
          AND OLD.uncounted_attempts IS NEW.uncounted_attempts
        )
      )
    )
    BEGIN
      SELECT RAISE(ABORT, 'project_skill_inputs only permits settle, one-shot window closure, and the delete tombstone');
    END
  `;

  yield* sql`
    CREATE TRIGGER IF NOT EXISTS project_skill_observed_uses_append_only
    BEFORE UPDATE ON project_skill_observed_uses
    FOR EACH ROW
    BEGIN
      SELECT RAISE(ABORT, 'project_skill_observed_uses rows are immutable');
    END
  `;
});
