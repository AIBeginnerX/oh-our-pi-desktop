import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * 071_PruneSupersededToolUpdatedActivities.
 *
 * One-time cleanup matching what the projector now does on `tool.completed`:
 * a `tool.updated` row is redundant once a later `tool.completed` of the same
 * thread, turn and tool call exists, and the read path already filters it out.
 *
 * Only calls identified by `toolCallId` (top-level, else `data.toolCallId`) are
 * expressible in SQL. Updates that rely on the itemType/title/detail fallback
 * identity stay; the read path keeps filtering them. Order follows the thread
 * activity order: rows without a sequence first, then sequence, createdAt and
 * activityId. `orchestration_events` is never touched.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    DELETE FROM projection_thread_activities
    WHERE activity_id IN (
      WITH keyed AS (
        SELECT
          activity_id,
          thread_id,
          COALESCE(turn_id, '') AS turn_key,
          kind,
          CASE WHEN json_valid(payload_json) THEN
            COALESCE(
              NULLIF(trim(CASE WHEN json_type(payload_json, '$.toolCallId') = 'text'
                THEN json_extract(payload_json, '$.toolCallId') END), ''),
              NULLIF(trim(CASE WHEN json_type(payload_json, '$.data.toolCallId') = 'text'
                THEN json_extract(payload_json, '$.data.toolCallId') END), '')
            )
          END AS call_id,
          printf('%d:%020d:%s:%s',
            sequence IS NOT NULL, COALESCE(sequence, 0), created_at, activity_id) AS order_key
        FROM projection_thread_activities
        WHERE kind IN ('tool.updated', 'tool.completed')
      ),
      last_completion AS (
        SELECT thread_id, turn_key, call_id, MAX(order_key) AS order_key
        FROM keyed
        WHERE kind = 'tool.completed' AND call_id IS NOT NULL
        GROUP BY thread_id, turn_key, call_id
      )
      SELECT updated.activity_id
      FROM keyed AS updated
      JOIN last_completion AS completion
        ON completion.thread_id = updated.thread_id
        AND completion.turn_key = updated.turn_key
        AND completion.call_id = updated.call_id
      WHERE updated.kind = 'tool.updated'
        AND completion.order_key > updated.order_key
    )
  `;
});
