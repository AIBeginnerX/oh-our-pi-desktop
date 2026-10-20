import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// A corrected observation window may change the unresolved-attempt count of
// an already closed, accepted trial. Every other original transition remains
// constrained, including the immutable closure time and managed-send label.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TRIGGER IF EXISTS project_skill_inputs_transitions`;
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
          OLD.window = 'closed' AND NEW.window = 'closed'
          AND OLD.delivery = 'provider-accepted' AND NEW.delivery = 'provider-accepted'
          AND OLD.tombstoned_at IS NULL AND NEW.tombstoned_at IS NULL
          AND OLD.window_closed_at IS NEW.window_closed_at
          AND OLD.delivery_at IS NEW.delivery_at
          AND OLD.provider_driver_kind IS NEW.provider_driver_kind
          AND OLD.managed_send_json IS NEW.managed_send_json
          AND OLD.skill_id IS NEW.skill_id AND OLD.version IS NEW.version
          AND OLD.content_sha256 IS NEW.content_sha256
          AND OLD.admitted_skill_state_seq IS NEW.admitted_skill_state_seq
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
      SELECT RAISE(ABORT, 'project_skill_inputs only permits settle, window closure, closed reconciliation, and the delete tombstone');
    END
  `;
});
