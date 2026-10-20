import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  EventId,
  isToolLifecycleItemType,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

/**
 * ProviderSafetyObservations - Safety events the provider reported before the projection saw them.
 *
 * Lets a restart tell that a tool start, approval or user-input request happened even if its
 * activity never reached the projection. Rows live until their thread is deleted, and a record
 * that fails followed by a crash is not detected.
 *
 * @module ProviderSafetyObservations
 */

const ObservationKindSchema = Schema.Literals([
  "tool.started",
  "approval.requested",
  "user-input.requested",
]);
export type ProviderSafetyObservationKind = typeof ObservationKindSchema.Type;

/**
 * The activity kind a runtime event projects to when a restart must not auto-continue past it,
 * or null for every other event. Mirrors the activities `runtimeEventToActivities` writes.
 */
export const safetyObservationKindOf = (
  event: ProviderRuntimeEvent,
): ProviderSafetyObservationKind | null => {
  switch (event.type) {
    case "item.started":
      return isToolLifecycleItemType(event.payload.itemType) ? "tool.started" : null;
    case "request.opened":
      return event.payload.requestType !== "tool_user_input" ? "approval.requested" : null;
    case "user-input.requested":
      return "user-input.requested";
    default:
      return null;
  }
};

const RecordRequestSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  eventId: EventId,
  kind: ObservationKindSchema,
});

const HasUnprojectedRequestSchema = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
});

const ExistsRowSchema = Schema.Struct({ exists: Schema.Number });

type ProviderSafetyObservationsError = PersistenceSqlError | PersistenceDecodeError;

export class ProviderSafetyObservations extends Context.Service<
  ProviderSafetyObservations,
  {
    /**
     * Insert one observation. The first row for a `(threadId, eventId)` wins; a repeat never
     * updates or replaces it.
     */
    readonly record: (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly eventId: EventId;
      readonly kind: ProviderSafetyObservationKind;
    }) => Effect.Effect<void, ProviderSafetyObservationsError>;

    /**
     * Whether the thread has an observation with no projected activity of the same thread, turn
     * (null-safe), id and kind. Counts observations of `turnId` and of no turn, never of another
     * turn. Unbounded: no row cap.
     */
    readonly hasUnprojected: (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId;
    }) => Effect.Effect<boolean, ProviderSafetyObservationsError>;
  }
>()("t3/persistence/ProviderSafetyObservations") {}

function toSqlOrDecodeError(sqlOperation: string, decodeOperation: string, threadId: ThreadId) {
  return (cause: unknown): ProviderSafetyObservationsError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, { threadId })
      : new PersistenceSqlError({
          operation: sqlOperation,
          correlation: { threadId },
          cause,
        });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertObservation = SqlSchema.void({
    Request: RecordRequestSchema,
    execute: ({ threadId, turnId, eventId, kind }) =>
      sql`
        INSERT INTO provider_safety_observations (
          thread_id,
          event_id,
          turn_id,
          kind,
          observed_at
        )
        VALUES (
          ${threadId},
          ${eventId},
          ${turnId},
          ${kind},
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        )
        ON CONFLICT (thread_id, event_id) DO NOTHING
      `,
  });

  const existsUnprojected = SqlSchema.findOne({
    Request: HasUnprojectedRequestSchema,
    Result: ExistsRowSchema,
    execute: ({ threadId, turnId }) =>
      sql`
        SELECT EXISTS (
          SELECT 1
          FROM provider_safety_observations AS o
          WHERE o.thread_id = ${threadId}
            AND (o.turn_id = ${turnId} OR o.turn_id IS NULL)
            AND NOT EXISTS (
              SELECT 1
              FROM projection_thread_activities AS a
              WHERE a.activity_id = o.event_id
                AND a.thread_id = o.thread_id
                AND a.kind = o.kind
                AND a.turn_id IS o.turn_id
            )
        ) AS "exists"
      `,
  });

  const record: ProviderSafetyObservations["Service"]["record"] = (input) =>
    insertObservation(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ProviderSafetyObservations.record:query",
          "ProviderSafetyObservations.record:encodeRequest",
          input.threadId,
        ),
      ),
    );

  const hasUnprojected: ProviderSafetyObservations["Service"]["hasUnprojected"] = (input) =>
    existsUnprojected(input).pipe(
      Effect.mapError(
        toSqlOrDecodeError(
          "ProviderSafetyObservations.hasUnprojected:query",
          "ProviderSafetyObservations.hasUnprojected:decodeRow",
          input.threadId,
        ),
      ),
      Effect.map((row) => row.exists === 1),
    );

  return { record, hasUnprojected } satisfies ProviderSafetyObservations["Service"];
});

export const layer = Layer.effect(ProviderSafetyObservations, make);
