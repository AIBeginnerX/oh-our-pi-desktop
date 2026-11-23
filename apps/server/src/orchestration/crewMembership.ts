import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type { SqlClient } from "effect/unstable/sql/SqlClient";

import { crewThreadCreationCommandId } from "../crew/crewLogic.ts";

export const readLegacyCrewMember = (sql: SqlClient, threadId: ThreadId) =>
  sql<{ readonly eventType: string; readonly commandId: string | null }>`
    SELECT event_type AS "eventType", command_id AS "commandId"
    FROM (
      SELECT event_type, command_id
      FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY sequence
      LIMIT 1
    )
    WHERE NOT EXISTS (
      SELECT 1 FROM projection_threads
      WHERE thread_id = ${threadId} AND parent_thread_id IS NOT NULL
    )
  `.pipe(
    Effect.map(
      ([first]) =>
        first?.eventType === "thread.created" &&
        first.commandId === crewThreadCreationCommandId(threadId),
    ),
  );
