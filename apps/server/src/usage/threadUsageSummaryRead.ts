/**
 * Chat usage footer read: aggregates a thread's owned-usage rows, including
 * its crew child threads, straight from the projection read model.
 *
 * No new stored data — two indexed, bounded queries: one over
 * `projection_thread_activities` for the usage rows, one over
 * `orchestration_events` for the model timeline (`thread.created`,
 * `thread.meta-updated`, `thread.turn-start-requested`). Each usage row is
 * attributed to the model its turn actually ran with, not the thread's
 * current selection, and priced with the same rate table and overrides the
 * Usage screen uses. Rows whose payload no longer decodes are skipped, and a
 * thread with more rows or model events than `THREAD_USAGE_MAX_ROWS` reports
 * "too-large" with no numbers rather than an unbounded read.
 *
 * @module threadUsageSummaryRead
 */
import { type ThreadId, type ThreadUsageSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { UsageService } from "./UsageService.ts";
import { OWNED_USAGE_ACTIVITY_KIND, OwnedTurnUsageObservationV1 } from "./ownedUsage.schema.ts";
import { aggregateThreadUsage } from "./threadUsageSummary.ts";
import type { RateTable } from "./usagePricing.ts";

/**
 * Row cap for the summary read. The `LIMIT` fetches one row past this so a
 * single query both bounds the read and detects the overflow.
 */
export const THREAD_USAGE_MAX_ROWS = 20_000;

/** One owned-usage projection row with its thread, turn, and row timestamp. */
export type ThreadUsageActivityRow = {
  readonly threadId: ThreadId;
  /** The activity's `turn_id`; null when the activity named no turn. */
  readonly turnId: string | null;
  readonly modelSelectionJson: string | null;
  readonly payloadJson: string;
  readonly createdAt: string;
};

/** One model-selection-relevant orchestration event for a thread family. */
export type ThreadUsageModelEventRow = {
  readonly streamId: ThreadId;
  readonly eventType: string;
  readonly occurredAt: string;
  readonly eventModel: string | null;
};

/** Zero totals for the too-large shape, which still carries the full summary structure. */
const emptyTotals: ThreadUsageSummary["totals"] = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: { sum: 0, reportedTurns: 0 },
  cacheCreationTokens: { sum: 0, reportedTurns: 0 },
  turns: 0,
  cacheRate: null,
  cost: { kind: "unknown" },
};

/** How far a summary reached: one turn, or the whole thread family. */
const summaryScope = (turnId: string | undefined): "turn" | "thread" =>
  turnId === undefined ? "thread" : "turn";

const decodeObservation = Schema.decodeUnknownOption(
  Schema.fromJsonString(OwnedTurnUsageObservationV1),
);

/**
 * The thread's selected model name. The read model persists `ModelSelection`
 * whose `model` field is the rate key on every wire shape, so a lenient
 * string read matches the decoded value and cannot fail a row on it.
 */
const modelFromSelectionJson = (json: string): string | null => {
  try {
    const parsed: unknown = JSON.parse(json);
    const model =
      typeof parsed === "object" && parsed !== null ? (parsed as { model?: unknown }).model : null;
    return typeof model === "string" && model.trim().length > 0 ? model : null;
  } catch {
    return null;
  }
};

/** A turn start on a thread: when it began and the model it ran with. */
type TurnStart = { readonly at: string; readonly model: string };

/**
 * Per-turn model resolution, walking each thread's events in sequence order:
 * `thread.created` and `thread.meta-updated` maintain the thread selection,
 * and a `thread.turn-start-requested` runs with its own `modelSelection` when
 * it carries one, else with that maintained selection. A turn start without
 * any resolvable model contributes nothing, so its rows fall through to the
 * legacy fallback.
 */
const turnStartsByThread = (
  events: ReadonlyArray<ThreadUsageModelEventRow>,
): Map<ThreadId, Array<TurnStart>> => {
  const selected = new Map<ThreadId, string>();
  const turnStarts = new Map<ThreadId, Array<TurnStart>>();
  for (const event of events) {
    const eventModel =
      event.eventModel !== null && event.eventModel.trim().length > 0 ? event.eventModel : null;
    if (event.eventType === "thread.turn-start-requested") {
      const model = eventModel ?? selected.get(event.streamId);
      if (model === undefined) continue;
      const starts = turnStarts.get(event.streamId) ?? [];
      starts.push({ at: event.occurredAt, model });
      turnStarts.set(event.streamId, starts);
    } else if (
      (event.eventType === "thread.created" || event.eventType === "thread.meta-updated") &&
      eventModel !== null
    ) {
      selected.set(event.streamId, eventModel);
    }
  }
  return turnStarts;
};

/**
 * The model of the latest turn start at or before the usage row; ISO
 * timestamps compare lexicographically.
 */
const modelAt = (
  starts: ReadonlyArray<TurnStart> | undefined,
  createdAt: string,
): string | null => {
  if (starts === undefined) return null;
  for (let i = starts.length - 1; i >= 0; i--) {
    if (starts[i]!.at <= createdAt) return starts[i]!.model;
  }
  return null;
};

/**
 * Pure reducer over projection rows and model events: attributes each row to
 * the model its turn ran with — the latest turn start at or before the row,
 * else the thread's current selection as today (rows predating any recorded
 * turn start) — then skips rows without a usable model or an undecodable
 * payload and aggregates the rest. `maxRows` is test-injected; callers pass
 * `THREAD_USAGE_MAX_ROWS` for both queries. Past the cap the summary reports
 * "too-large" with empty totals and models — no numbers is not zero usage.
 *
 * `turnId` narrows the counted rows to that turn: the lead thread's rows of
 * the turn plus every row of the family's other threads (the crew children of
 * the turn). The cost chains still step over the whole family first, so the
 * turn's cost is its own step of its provider chain, not the running total.
 * The response says which scope it counted, and thread scope is also what an
 * omitted `turnId` reports.
 */
export const deriveThreadUsageSummary = (
  threadId: ThreadId,
  rows: ReadonlyArray<ThreadUsageActivityRow>,
  rates: RateTable,
  overrides: RateTable,
  maxRows: number,
  modelEvents: ReadonlyArray<ThreadUsageModelEventRow> = [],
  turnId?: string,
  turnChildren: ReadonlySet<ThreadId> = NO_TURN_CHILDREN,
): ThreadUsageSummary => {
  const scope = summaryScope(turnId);
  if (rows.length > maxRows || modelEvents.length > maxRows)
    return { threadId, status: "too-large", scope, totals: emptyTotals, models: [] };
  const turnStarts = turnStartsByThread(modelEvents);
  const entries: Array<{
    threadId: ThreadId;
    turnId: string | null;
    createdAt: string;
    model: string;
    observation: OwnedTurnUsageObservationV1;
  }> = [];
  for (const row of rows) {
    const currentModel =
      row.modelSelectionJson === null ? null : modelFromSelectionJson(row.modelSelectionJson);
    const model = modelAt(turnStarts.get(row.threadId), row.createdAt) ?? currentModel;
    const observation =
      model === null ? null : Option.getOrNull(decodeObservation(row.payloadJson));
    if (model === null || observation === null) continue;
    entries.push({
      threadId: row.threadId,
      turnId: row.turnId,
      createdAt: row.createdAt,
      model,
      observation,
    });
  }
  const counted =
    turnId === undefined
      ? undefined
      : (entry: { threadId: ThreadId; turnId: string | null }) =>
          entry.threadId !== threadId ? turnChildren.has(entry.threadId) : entry.turnId === turnId;
  return { ...aggregateThreadUsage(threadId, entries, rates, overrides, counted), scope };
};

/** An empty set is the turn-children set of a thread-scoped read. */
const NO_TURN_CHILDREN: ReadonlySet<ThreadId> = new Set();

/**
 * Reads the summary for one thread and its crew child threads
 * (`projection_threads.parent_thread_id`) through the real projection store.
 * With `turnId`, only that turn is counted: the lead thread's observations of
 * the turn plus, in full, the crew child threads started during it — the
 * threads the lead's turn-scoped `task.*` activities name — including the
 * turn's auditor, which starts the same way. Children of other turns stay out.
 */
export const readThreadUsageSummary = Effect.fn("threadUsageSummary.read")(function* (
  threadId: ThreadId,
  turnId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService;
  const { rates, overrides } = yield* usage.pricingTables;
  const rows = yield* sql<ThreadUsageActivityRow>`
    SELECT
      a.thread_id AS "threadId",
      a.turn_id AS "turnId",
      t.model_selection_json AS "modelSelectionJson",
      a.payload_json AS "payloadJson",
      a.created_at AS "createdAt"
    FROM projection_thread_activities AS a
    JOIN projection_threads AS t ON t.thread_id = a.thread_id
    WHERE a.kind = ${OWNED_USAGE_ACTIVITY_KIND}
      AND a.thread_id IN (
        SELECT thread_id FROM projection_threads
        WHERE thread_id = ${threadId} OR parent_thread_id = ${threadId}
      )
    ORDER BY a.created_at
    LIMIT ${THREAD_USAGE_MAX_ROWS + 1}
  `;
  const modelEvents = yield* sql<ThreadUsageModelEventRow>`
    SELECT
      stream_id AS "streamId",
      event_type AS "eventType",
      occurred_at AS "occurredAt",
      json_extract(payload_json, '$.modelSelection.model') AS "eventModel"
    FROM orchestration_events
    WHERE aggregate_kind = 'thread'
      AND event_type IN ('thread.created', 'thread.meta-updated', 'thread.turn-start-requested')
      AND stream_id IN (
        SELECT thread_id FROM projection_threads
        WHERE thread_id = ${threadId} OR parent_thread_id = ${threadId}
      )
    ORDER BY sequence
    LIMIT ${THREAD_USAGE_MAX_ROWS + 1}
  `;
  // The crew child threads the turn started, read straight off the lead's
  // turn-scoped task activities; the whole family read above feeds the cost
  // chains, and the filter keeps only the turn's share of it.
  const turnChildren =
    turnId === undefined
      ? NO_TURN_CHILDREN
      : new Set(
          (yield* sql<{ readonly childThreadId: ThreadId }>`
              SELECT DISTINCT json_extract(a.payload_json, '$.threadId') AS "childThreadId"
              FROM projection_thread_activities AS a
              WHERE a.thread_id = ${threadId}
                AND a.turn_id = ${turnId}
                AND a.kind IN ('task.started', 'task.progress', 'task.completed')
                AND json_extract(a.payload_json, '$.threadId') IN (
                  SELECT thread_id FROM projection_threads
                  WHERE parent_thread_id = ${threadId}
                )
            `).map((row) => row.childThreadId),
        );
  return deriveThreadUsageSummary(
    threadId,
    rows,
    rates,
    overrides,
    THREAD_USAGE_MAX_ROWS,
    modelEvents,
    turnId,
    turnChildren,
  );
});
