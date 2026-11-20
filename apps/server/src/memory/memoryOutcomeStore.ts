import type { ProjectId, ProjectMemory, ProjectMemoryOutcomeCounts } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { judgeMemoryOutcome } from "./memoryOutcomes.ts";
import type { ThreadWorkDigest } from "./workDigest.ts";

/**
 * A send has an outcome once the provider took the turn, or when the agent pulled the memory with
 * the recall tool (a synthetic `recall:` message id). Any other attempt may never have arrived: a
 * hand-off the provider refused settles as `external_send_unknown` too.
 */
const delivered = (sql: SqlClient.SqlClient) =>
  sql`(a.state = 'provider_accepted' OR substr(a.message_id, 1, 7) = 'recall:')`;

export const recordMemoryOutcomes = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  projectId: ProjectId,
  work: {
    readonly digest: ThreadWorkDigest;
    readonly signalTimes: ReadonlyMap<number, number>;
    readonly createdAt: number;
  },
) {
  const { digest, signalTimes, createdAt } = work;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const sends = yield* sql<{
        memoryId: string;
        version: number;
        sentAfter: number | null;
        sentAt: string;
      }>`
        SELECT i.memory_id AS "memoryId", i.memory_version AS version,
          a.sent_after_event_sequence AS "sentAfter", a.committed_at AS "sentAt"
        FROM project_memory_send_attempts a
        JOIN project_memory_send_items i ON i.attempt_seq = a.attempt_seq
        JOIN project_memories m ON m.project_id = a.project_id AND m.memory_id = i.memory_id
        WHERE a.project_id = ${projectId} AND a.thread_id = ${digest.threadId}
          AND ${delivered(sql)}
        ORDER BY a.attempt_seq
      `;
      // A thread contributes once per version, starting at its first exposure.
      const seen = new Set<string>();
      for (const send of sends) {
        const sentAt = Date.parse(send.sentAt);
        if (send.sentAfter === null ? sentAt < createdAt : send.sentAfter < digest.firstSequence) {
          continue;
        }
        const key = `${send.version}:${send.memoryId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // Legacy sends only have a timestamp. Same-time events are ambiguous.
        const signals =
          send.sentAfter === null
            ? digest.signals.filter((signal) => (signalTimes.get(signal.eventSeq) ?? 0) > sentAt)
            : digest.signals;
        const outcome = judgeMemoryOutcome(signals, send.sentAfter ?? 0);
        yield* sql`
          INSERT INTO project_memory_outcomes (
            project_id, memory_id, memory_version, thread_id, outcome, judged_at_event_sequence
          )
          VALUES (
            ${projectId}, ${send.memoryId}, ${send.version}, ${digest.threadId},
            ${outcome}, ${digest.lastSequence}
          )
          ON CONFLICT (project_id, memory_id, memory_version, thread_id) DO UPDATE SET
            outcome = excluded.outcome, judged_at_event_sequence = excluded.judged_at_event_sequence
          WHERE excluded.judged_at_event_sequence >= project_memory_outcomes.judged_at_event_sequence
        `;
      }
    }),
  );
});

export const listMemoryOutcomeCounts = (
  sql: SqlClient.SqlClient,
  items: ReadonlyArray<ProjectMemory>,
  projectId: ProjectId,
) =>
  sql<ProjectMemoryOutcomeCounts & { readonly memoryId: string; readonly version: number }>`
    SELECT m.memory_id AS "memoryId", m.version,
      COUNT(DISTINCT a.thread_id) AS sent,
      COUNT(DISTINCT CASE WHEN o.outcome = 'good' THEN a.thread_id END) AS good,
      COUNT(DISTINCT CASE WHEN o.outcome = 'bad' THEN a.thread_id END) AS bad,
      COUNT(DISTINCT CASE WHEN o.outcome IS NULL OR o.outcome = 'unknown' THEN a.thread_id END) AS unknown
    FROM project_memories m
    JOIN project_memory_send_items i ON i.memory_id = m.memory_id AND i.memory_version = m.version
    JOIN project_memory_send_attempts a ON a.attempt_seq = i.attempt_seq AND a.project_id = m.project_id
      AND ${delivered(sql)}
    LEFT JOIN project_memory_outcomes o ON o.project_id = m.project_id AND o.memory_id = m.memory_id
      AND o.memory_version = m.version AND o.thread_id = a.thread_id
    WHERE m.project_id = ${projectId} AND m.memory_id IN ${sql.in(items.map((item) => item.memoryId))}
    GROUP BY m.memory_id, m.version
  `;
