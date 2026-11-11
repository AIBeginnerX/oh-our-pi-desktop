import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { incrementalVacuumPass } from "./SqliteMaintenance.ts";

/**
 * Event-store compaction: background maintenance that deletes events no reader
 * needs, so `orchestration_events` grows slower. Each rule deletes only what
 * the read path already hides, so a projector rebuild from the compacted
 * stream yields the same visible state:
 * - `tool.updated` events that a later `tool.completed` of the same call
 *   (same turn and `toolCallId`) supersedes, as `isSupersededToolUpdate`
 *   decides for the projector and the read path.
 * - `context-window.updated` events that a later resolvable meter of the same
 *   turn supersedes, together with their projection rows, which the read path
 *   filters (`dropStaleContextWindowActivities`) but the projector keeps.
 *
 * Only events older than the age cutoff and at or below every projector cursor
 * are candidates, so a projector catching up never misses one and running
 * threads are untouched. node:sqlite is synchronous and every query blocks the
 * server, so the pass reads bounded sequence windows, deletes in bounded
 * batches, and yields after every statement: the scheduler resumes a yield
 * through setImmediate, so requests waiting on the event loop run in between.
 * docs/internals/event-store-retention.md lists what must never be pruned.
 */

const COMPACTION_BATCH_SIZE = 500;
const COMPACTION_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Sequences read per query. Windows overlap by half, so a superseded event and
 * the event that supersedes it share a window when they are at most half a
 * window apart; on real data a completion follows its updates within ~3,100.
 */
const COMPACTION_WINDOW = 10_000;
const FIRST_RUN_DELAY = "30 minutes";
const RUN_INTERVAL = "24 hours";

/**
 * The tool-call identity migration 071 and `toolLifecycleIdentity` agree on:
 * a `toolCallId` (top level, else under `data`). Updates identified only by
 * the itemType/title/detail fallback stay; the read path keeps filtering them.
 * ISO timestamps in this database compare lexicographically, so string
 * comparisons against the cutoff are time comparisons.
 */
const CALL_ID = `COALESCE(
  NULLIF(trim(CASE WHEN json_type(payload_json, '$.activity.payload.toolCallId') = 'text'
    THEN json_extract(payload_json, '$.activity.payload.toolCallId') END), ''),
  NULLIF(trim(CASE WHEN json_type(payload_json, '$.activity.payload.data.toolCallId') = 'text'
    THEN json_extract(payload_json, '$.activity.payload.data.toolCallId') END), '')
)`;

/**
 * The read path sorts a thread's activities by the activity's own `sequence`
 * (rows without one first), then `createdAt`, then id
 * (`ProjectionThreadActivities`), and decides what is superseded in that order,
 * not in event order. Today these activities carry no `sequence`, so
 * `createdAt` decides. Both rules sort the same way, so every deleted event has
 * a kept event after it in the order the read path and a rebuild use.
 */
const ACTIVITY_COLUMNS = `
  sequence,
  stream_id,
  occurred_at,
  COALESCE(json_extract(payload_json, '$.activity.turnId'), '') AS turn_key,
  json_extract(payload_json, '$.activity.sequence') AS activity_sequence,
  json_extract(payload_json, '$.activity.createdAt') AS created_at,
  json_extract(payload_json, '$.activity.id') AS activity_id
`;
const THREAD_ORDER = `activity_sequence IS NOT NULL, activity_sequence, created_at, activity_id`;
const THREAD_ORDER_DESC = `activity_sequence IS NOT NULL DESC, activity_sequence DESC,
  created_at DESC, activity_id DESC`;

// Parameters: first sequence, last sequence, cutoff, cutoff.
const SUPERSEDED_TOOL_UPDATED_SQL = `
  SELECT sequence FROM (
    SELECT
      sequence,
      kind,
      occurred_at,
      MAX(CASE WHEN kind = 'tool.completed' THEN occurred_at END) OVER (
        PARTITION BY stream_id, turn_key, call_id
        ORDER BY ${THREAD_ORDER}
        ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
      ) AS later_completion_at
    FROM (
      SELECT
        ${ACTIVITY_COLUMNS},
        json_extract(payload_json, '$.activity.kind') AS kind,
        ${CALL_ID} AS call_id
      FROM orchestration_events
      WHERE sequence BETWEEN ? AND ?
        AND event_type = 'thread.activity-appended'
        AND json_extract(payload_json, '$.activity.kind') IN ('tool.updated', 'tool.completed')
    )
    WHERE call_id IS NOT NULL
  )
  WHERE kind = 'tool.updated'
    AND occurred_at < ?
    AND later_completion_at < ?
`;

// Parameters: first sequence, last sequence, cutoff, cutoff.
const STALE_CONTEXT_WINDOW_SQL = `
  SELECT sequence, activity_id AS "activityId" FROM (
    SELECT
      sequence,
      activity_id,
      occurred_at,
      ROW_NUMBER() OVER (
        PARTITION BY stream_id, turn_key ORDER BY ${THREAD_ORDER_DESC}
      ) AS newest_rank,
      MAX(occurred_at) OVER (PARTITION BY stream_id, turn_key) AS last_at
    FROM (
      SELECT ${ACTIVITY_COLUMNS}
      FROM orchestration_events
      WHERE sequence BETWEEN ? AND ?
        AND event_type = 'thread.activity-appended'
        AND json_extract(payload_json, '$.activity.kind') = 'context-window.updated'
        AND json_type(payload_json, '$.activity.payload.usedTokens') IN ('integer', 'real')
        AND json_extract(payload_json, '$.activity.payload.usedTokens') >= 0
    )
  )
  WHERE newest_rank > 1
    AND occurred_at < ?
    AND last_at < ?
`;

export const compactionPass = Effect.fn("EventStoreCompaction.compactionPass")(function* (
  input: {
    readonly batchSize?: number;
    readonly windowSize?: number;
    readonly ageMs?: number;
  } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  const batchSize = Math.max(1, input.batchSize ?? COMPACTION_BATCH_SIZE);
  const windowSize = Math.max(2, input.windowSize ?? COMPACTION_WINDOW);
  const startedAt = yield* Clock.currentTimeMillis;
  const cutoff = DateTime.formatIso(
    DateTime.makeUnsafe(startedAt - (input.ageMs ?? COMPACTION_AGE_MS)),
  );
  const removed = { supersededToolUpdatedEvents: 0, staleContextWindowEvents: 0, batches: 0 };

  const inBatches = <Key, E>(
    keys: ReadonlyArray<Key>,
    run: (batch: ReadonlyArray<Key>) => Effect.Effect<unknown, E>,
  ) =>
    Effect.gen(function* () {
      for (let index = 0; index < keys.length; index += batchSize) {
        yield* run(keys.slice(index, index + batchSize));
        removed.batches += 1;
        yield* Effect.yieldNow;
      }
    });
  const deleteEvents = (sequences: ReadonlyArray<number>) =>
    inBatches(
      sequences,
      (batch) => sql`DELETE FROM orchestration_events WHERE ${sql.in("sequence", batch)}`,
    );
  const deleteMeterRows = (activityIds: ReadonlyArray<string>) =>
    inBatches(
      activityIds,
      (batch) =>
        sql`DELETE FROM projection_thread_activities WHERE ${sql.in("activity_id", batch)}`,
    );

  // A projector behind `floor` has not applied the event yet, so nothing after
  // it may be deleted. Before the first bootstrap there is no cursor.
  const bounds = yield* sql<{ readonly first: number | null; readonly floor: number | null }>`
    SELECT
      (SELECT MIN(sequence) FROM orchestration_events) AS "first",
      (SELECT MIN(last_applied_sequence) FROM projection_state) AS "floor"
  `;
  const first = bounds[0]?.first ?? null;
  const floor = bounds[0]?.floor ?? null;
  if (first !== null && floor !== null) {
    const step = Math.floor(windowSize / 2);
    for (let from = first; from <= floor; from += step) {
      const through = Math.min(from + windowSize - 1, floor);
      const toolUpdated = yield* sql.unsafe<{ readonly sequence: number }>(
        SUPERSEDED_TOOL_UPDATED_SQL,
        [from, through, cutoff, cutoff],
      );
      yield* Effect.yieldNow;
      yield* deleteEvents(toolUpdated.map((row) => row.sequence));
      const contextWindow = yield* sql.unsafe<{
        readonly sequence: number;
        readonly activityId: string | null;
      }>(STALE_CONTEXT_WINDOW_SQL, [from, through, cutoff, cutoff]);
      yield* Effect.yieldNow;
      yield* deleteEvents(contextWindow.map((row) => row.sequence));
      yield* deleteMeterRows(
        contextWindow.flatMap((row) => (row.activityId === null ? [] : [row.activityId])),
      );
      removed.supersededToolUpdatedEvents += toolUpdated.length;
      removed.staleContextWindowEvents += contextWindow.length;
    }
  }

  const result = { ...removed, durationMs: (yield* Clock.currentTimeMillis) - startedAt };
  if (result.batches > 0) {
    yield* Effect.logInfo("compacted event store", { ...result, cutoff });
    // Freed pages only leave the file through the incremental vacuum path.
    yield* incrementalVacuumPass;
  }
  return result;
});

/** Runs once projectors and receipt pruning have settled after start, then daily. */
export const periodicEventStoreCompaction = Effect.sleep(FIRST_RUN_DELAY).pipe(
  Effect.andThen(
    compactionPass().pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) => Effect.logWarning("event store compaction failed", { cause }),
      ),
      Effect.repeat(Schedule.spaced(RUN_INTERVAL)),
    ),
  ),
  Effect.asVoid,
);
