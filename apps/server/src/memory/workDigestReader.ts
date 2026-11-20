import {
  OWNED_USAGE_ACTIVITY_KIND,
  SELECTED_CHECK_RECEIPT_KIND,
  TASK_RESULT_ACTIVITY_KIND,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { deriveWorkDigest, type WorkDigestEvent } from "./workDigest.ts";

const MAX_DIGEST_EVENTS = 50_000;

/**
 * Read only digest-bearing events from the latest incarnation. The bound
 * applies to relevant events, so tool traffic and chat cannot exhaust it.
 *
 * A worker or expert completion is appended to its lead thread but describes
 * the crew thread named in its payload, so it is read from `leadId` and
 * counted there, never in the lead's own digest. An auditor reviews the
 * lead's turn, so its verdict stays with the lead, where a later approval can
 * close an earlier request for changes.
 */
export const readThreadWorkDigest = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  leadId: ThreadId | null,
) =>
  sql<{
    sequence: number;
    occurredAt: string;
    type: Extract<WorkDigestEvent, { aggregateKind: "thread" }>["type"];
    payload: string;
  }>`
    SELECT sequence, occurred_at AS "occurredAt", event_type AS type,
      CASE event_type
        WHEN 'thread.message-sent' THEN json_object(
          'role', 'user', 'streaming', json('false'),
          'text', CASE WHEN instr(json_extract(payload_json, '$.text'), '<oop_crew_follow_up ') > 0
            THEN json_extract(payload_json, '$.text') ELSE '' END
        )
        WHEN 'thread.activity-appended' THEN payload_json
        WHEN 'thread.turn-diff-completed' THEN payload_json
        ELSE '{}'
      END AS payload
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND sequence >= (
        SELECT MAX(sequence) FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND event_type = 'thread.created'
      )
      AND (
        (stream_id = ${threadId} AND (
          event_type IN ('thread.created', 'thread.reverted', 'thread.turn-interrupt-requested', 'thread.turn-diff-completed')
          OR (event_type = 'thread.message-sent'
            AND json_extract(payload_json, '$.role') = 'user'
            AND COALESCE(json_extract(payload_json, '$.streaming'), 0) = 0)
          OR (event_type = 'thread.activity-appended'
            AND json_extract(payload_json, '$.activity.kind') IN (
              ${SELECTED_CHECK_RECEIPT_KIND}, ${TASK_RESULT_ACTIVITY_KIND}, ${OWNED_USAGE_ACTIVITY_KIND}
            ))
          OR (event_type = 'thread.activity-appended'
            AND json_extract(payload_json, '$.activity.kind') = 'task.completed'
            AND json_extract(payload_json, '$.activity.payload.crewRole') = 'auditor')
        ))
        OR (stream_id = ${leadId} AND event_type = 'thread.activity-appended'
          AND json_extract(payload_json, '$.activity.kind') = 'task.completed'
          AND json_extract(payload_json, '$.activity.payload.crewRole') IN ('worker', 'expert')
          AND json_extract(payload_json, '$.activity.payload.threadId') = ${threadId})
      )
    ORDER BY sequence
    LIMIT ${MAX_DIGEST_EVENTS + 1}
  `.pipe(
    Effect.map((rows) => {
      if (rows.length === 0 || rows.length > MAX_DIGEST_EVENTS) return null;
      // These payloads were encoded by the event store. The SQL projects only
      // the fields the digest uses from messages, with text kept only for crew
      // follow-ups, and omits every other message.
      const events = rows.map(
        ({ sequence, type, payload }) =>
          ({
            sequence,
            type,
            aggregateKind: "thread",
            aggregateId: threadId,
            payload: JSON.parse(payload),
          }) as WorkDigestEvent,
      );
      const digest = deriveWorkDigest(threadId, events);
      const signalSequences = new Set(digest.signals.map((signal) => signal.eventSeq));
      const signalTimes = new Map(
        rows
          .filter((row) => signalSequences.has(row.sequence))
          .map((row) => [row.sequence, Date.parse(row.occurredAt)]),
      );
      return { digest, signalTimes, createdAt: Date.parse(rows[0]!.occurredAt) };
    }),
  );
