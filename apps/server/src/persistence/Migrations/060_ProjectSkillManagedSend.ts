import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 060_ProjectSkillManagedSend (C2 managed-capture storage).
 *
 * - `project_skill_inputs.managed_send_json` is the one optional managed-send
 *   evidence label: written at most once, and only inside the same UPDATE
 *   that moves delivery unknown -> provider-accepted. Rows claimed before
 *   this migration keep NULL — there is no backfill, and a row that settled
 *   unlabelled can never gain the label on a later settle. The JSON carries
 *   digests, ids, and scope only; prompt bodies are never persisted.
 * - `project_skill_inputs_transitions` is recreated: the settle transition is
 *   the single assignment slot for the label (OLD must be NULL), every other
 *   permitted transition holds it unchanged, and the delete tombstone purges
 *   it along with the ref payload while keeping the delivery ownership row.
 * - `project_skill_trials_on_version_delete` is recreated so the tombstone
 *   write clears `managed_send_json` in the same statement.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE project_skill_inputs
    ADD COLUMN managed_send_json TEXT
  `;

  yield* sql`DROP TRIGGER IF EXISTS project_skill_inputs_transitions`;

  // Same three permitted transitions as 059, with the label rules added: the
  // settle transition may lift managed_send_json NULL -> value (its only
  // assignment), window closure holds it, and the tombstone forces it NULL.
  yield* sql`
    CREATE TRIGGER project_skill_inputs_transitions
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
          AND OLD.managed_send_json IS NULL
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
          AND OLD.managed_send_json IS NEW.managed_send_json
          AND OLD.skill_id IS NEW.skill_id AND OLD.version IS NEW.version
          AND OLD.content_sha256 IS NEW.content_sha256
          AND OLD.admitted_skill_state_seq IS NEW.admitted_skill_state_seq
          AND OLD.tombstoned_at IS NEW.tombstoned_at
        )
        OR (
          OLD.skill_id IS NOT NULL AND NEW.skill_id IS NULL
          AND NEW.version IS NULL AND NEW.content_sha256 IS NULL
          AND NEW.admitted_skill_state_seq IS NULL
          AND NEW.managed_send_json IS NULL
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

  yield* sql`DROP TRIGGER IF EXISTS project_skill_trials_on_version_delete`;

  // Same delete cascade as 059 plus the managed-evidence purge: the payload
  // fields and the label drop together; the ownership row and token stay.
  yield* sql`
    CREATE TRIGGER project_skill_trials_on_version_delete
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
          admitted_skill_state_seq = NULL, managed_send_json = NULL,
          tombstoned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE skill_id = OLD.skill_id AND version = OLD.version
          AND content_sha256 = OLD.content_sha256;
    END
  `;
});
