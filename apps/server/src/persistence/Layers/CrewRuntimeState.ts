import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { PersistenceSqlError } from "../Errors.ts";
import {
  CrewRuntimeState,
  type CrewFollowUpCheckpoint,
  type CrewTaskCheckpoint,
} from "../Services/CrewRuntimeState.ts";

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failed = (operation: string) => (cause: unknown) =>
    new PersistenceSqlError({ operation, cause });

  return CrewRuntimeState.of({
    saveTask: (checkpoint) =>
      sql`
        INSERT INTO crew_tasks (task_id, lead_thread_id, record_json, updated_at)
        VALUES (
          ${checkpoint.task_id}, ${checkpoint.lead_thread_id},
          ${checkpoint.record_json}, ${checkpoint.updated_at}
        )
        ON CONFLICT (task_id) DO UPDATE SET
          record_json = excluded.record_json,
          updated_at = excluded.updated_at
        WHERE crew_tasks.lead_thread_id = excluded.lead_thread_id
      `.pipe(Effect.asVoid, Effect.mapError(failed("CrewRuntimeState.saveTask"))),
    readTasks: sql<CrewTaskCheckpoint>`
      SELECT task_id, lead_thread_id, record_json, updated_at FROM crew_tasks
      ORDER BY task_id
    `.pipe(Effect.mapError(failed("CrewRuntimeState.readTasks"))),
    prepareFollowUp: (checkpoint) =>
      sql`
        INSERT INTO crew_followups (
          delivery_id, lead_thread_id, command_id, message_id, record_json, created_at
        )
        VALUES (
          ${checkpoint.delivery_id}, ${checkpoint.lead_thread_id},
          ${checkpoint.command_id}, ${checkpoint.message_id},
          ${checkpoint.record_json}, ${checkpoint.created_at}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failed("CrewRuntimeState.prepareFollowUp"))),
    readFollowUps: sql<CrewFollowUpCheckpoint>`
      SELECT delivery_id, lead_thread_id, command_id, message_id, record_json,
             created_at, delivered_at, rejected_at
      FROM crew_followups ORDER BY created_at, delivery_id
    `.pipe(Effect.mapError(failed("CrewRuntimeState.readFollowUps"))),
    acknowledgeFollowUp: (deliveryId, deliveredAt) =>
      sql`
        UPDATE crew_followups SET delivered_at = ${deliveredAt}
        WHERE delivery_id = ${deliveryId} AND delivered_at IS NULL AND rejected_at IS NULL
      `.pipe(Effect.asVoid, Effect.mapError(failed("CrewRuntimeState.acknowledgeFollowUp"))),
    rejectFollowUp: (deliveryId, rejectedAt) =>
      sql`
        UPDATE crew_followups SET rejected_at = ${rejectedAt}
        WHERE delivery_id = ${deliveryId} AND delivered_at IS NULL AND rejected_at IS NULL
      `.pipe(Effect.asVoid, Effect.mapError(failed("CrewRuntimeState.rejectFollowUp"))),
  });
});

export const layer = Layer.effect(CrewRuntimeState, make);
