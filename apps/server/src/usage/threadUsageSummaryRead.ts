/**
 * Chat usage footer read for a request or the whole thread family, including
 * owned usage and the latest context window of each counted thread.
 *
 * Projection rows are attributed using the model timeline from
 * `orchestration_events`. Usage uses the Usage screen's rates and overrides.
 * Rows with undecodable payloads are skipped. Reads exceeding the row cap
 * report "too-large" with no numbers.
 *
 * @module threadUsageSummaryRead
 */
import { type ThreadId, type ThreadUsageSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { isCrewFollowUp } from "../crew/crewLogic.ts";
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

type RequestTurn = {
  readonly turnId: string;
  readonly text: string | null;
};

/** Walks newest-first lead turns from the named turn back to its user message. */
export const requestTurnIds = (turns: ReadonlyArray<RequestTurn>, turnId: string): string[] => {
  const start = turns.findIndex((turn) => turn.turnId === turnId);
  if (start === -1) return [turnId];
  const ids: string[] = [];
  for (const turn of turns.slice(start)) {
    ids.push(turn.turnId);
    if (typeof turn.text === "string" && !isCrewFollowUp(turn.text)) break;
  }
  return ids;
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

type UsageRequest = {
  readonly turnIds: ReadonlySet<string>;
  readonly children: ReadonlySet<ThreadId>;
};

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
 * The model of the latest turn start at or before the activity; ISO
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

type ModelUsageRow = ThreadUsageSummary["models"][number];
type UsageContext = NonNullable<ModelUsageRow["context"]>;
type ContextActivityRow = Omit<ThreadUsageActivityRow, "turnId">;

const decodeContextPayload = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const readContext = (json: string): UsageContext | undefined => {
  const payload = Option.getOrNull(decodeContextPayload(json));
  if (typeof payload !== "object" || payload === null) return undefined;
  const { usedTokens, maxTokens } = payload as { usedTokens?: unknown; maxTokens?: unknown };
  if (typeof usedTokens !== "number" || !Number.isFinite(usedTokens) || usedTokens < 0)
    return undefined;
  return {
    usedTokens,
    maxTokens:
      typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
        ? maxTokens
        : null,
  };
};

const contextFullness = ({ usedTokens, maxTokens }: UsageContext): number =>
  maxTokens !== null && maxTokens > 0 ? usedTokens / maxTokens : usedTokens;

/** Attaches the fullest latest context reported by the counted threads for each model. */
export const attachModelContexts = (
  models: ThreadUsageSummary["models"],
  snapshots: ReadonlyArray<ContextActivityRow>,
  modelEvents: ReadonlyArray<ThreadUsageModelEventRow>,
  countedThreads?: ReadonlySet<ThreadId>,
): ReadonlyArray<ModelUsageRow> => {
  const turnStarts = turnStartsByThread(modelEvents);
  const contexts = new Map<string, UsageContext>();
  for (const row of snapshots) {
    if (countedThreads !== undefined && !countedThreads.has(row.threadId)) continue;
    const context = readContext(row.payloadJson);
    if (context === undefined) continue;
    const model =
      modelAt(turnStarts.get(row.threadId), row.createdAt) ??
      (row.modelSelectionJson === null ? null : modelFromSelectionJson(row.modelSelectionJson));
    if (model === null) continue;
    const previous = contexts.get(model);
    if (previous === undefined || contextFullness(context) > contextFullness(previous))
      contexts.set(model, context);
  }
  return models.map((row) => {
    const context = contexts.get(row.model);
    return context === undefined ? row : { ...row, context };
  });
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
 * A request counts the lead's request turns and every row of its crew
 * children. Cost chains step over the whole family before counting each
 * request's share. Without a request, the summary counts the whole family.
 */
export const deriveThreadUsageSummary = (
  threadId: ThreadId,
  rows: ReadonlyArray<ThreadUsageActivityRow>,
  rates: RateTable,
  overrides: RateTable,
  maxRows: number,
  modelEvents: ReadonlyArray<ThreadUsageModelEventRow> = [],
  request?: UsageRequest,
): ThreadUsageSummary => {
  const scope = request === undefined ? "thread" : "turn";
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
    request === undefined
      ? undefined
      : (entry: { threadId: ThreadId; turnId: string | null }) =>
          entry.threadId !== threadId
            ? request.children.has(entry.threadId)
            : entry.turnId !== null && request.turnIds.has(entry.turnId);
  return {
    ...aggregateThreadUsage(threadId, entries, rates, overrides, counted),
    scope,
    ...(request === undefined ? {} : { requestAggregated: true }),
  };
};

/**
 * Reads the summary for one thread and its crew child threads
 * (`projection_threads.parent_thread_id`) through the real projection store.
 * With `turnId`, counts the request containing that turn, including the crew
 * children and auditors named by the lead's `task.*` activities in the request.
 */
export const readThreadUsageSummary = Effect.fn("threadUsageSummary.read")(function* (
  threadId: ThreadId,
  turnId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const usage = yield* UsageService;
  const { rates, overrides } = yield* usage.pricingTables;
  const requestTurns =
    turnId === undefined
      ? undefined
      : requestTurnIds(
          yield* sql<RequestTurn>`
            SELECT t.turn_id AS "turnId", MAX(m.text) AS text
            FROM projection_turns AS t
            LEFT JOIN projection_thread_messages AS m ON m.message_id = t.pending_message_id
            WHERE t.thread_id = ${threadId} AND t.turn_id IS NOT NULL
            GROUP BY t.turn_id
            ORDER BY MIN(t.requested_at) DESC, MAX(t.row_id) DESC
            LIMIT 200
          `,
          turnId,
        );
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
  const request: UsageRequest | undefined =
    requestTurns === undefined
      ? undefined
      : {
          turnIds: new Set(requestTurns),
          children: new Set(
            (yield* sql<{ readonly childThreadId: ThreadId }>`
              SELECT DISTINCT json_extract(a.payload_json, '$.threadId') AS "childThreadId"
              FROM projection_thread_activities AS a
              WHERE a.thread_id = ${threadId}
                AND ${sql.in("a.turn_id", requestTurns)}
                AND a.kind IN ('task.started', 'task.progress', 'task.completed')
                AND json_extract(a.payload_json, '$.threadId') IN (
                  SELECT thread_id FROM projection_threads
                  WHERE parent_thread_id = ${threadId}
                )
            `).map((row) => row.childThreadId),
          ),
        };
  const summary = deriveThreadUsageSummary(
    threadId,
    rows,
    rates,
    overrides,
    THREAD_USAGE_MAX_ROWS,
    modelEvents,
    request,
  );
  if (summary.status !== "ok") return summary;
  // Task receipts identify participants independently of optional provider usage.
  // Keep these rows out of token/cost chains: absence is not a zero receipt.
  const participants = yield* sql<{ threadId: ThreadId; modelSelectionJson: string }>`
    SELECT thread_id AS "threadId", model_selection_json AS "modelSelectionJson"
    FROM projection_threads
    WHERE parent_thread_id = ${threadId}
    LIMIT ${THREAD_USAGE_MAX_ROWS + 1}
  `;
  if (participants.length > THREAD_USAGE_MAX_ROWS)
    return { ...summary, status: "too-large" as const, totals: emptyTotals, models: [] };
  const models = [...summary.models];
  for (const participant of participants) {
    if (request !== undefined && !request.children.has(participant.threadId)) continue;
    const model = modelFromSelectionJson(participant.modelSelectionJson);
    if (model === null || models.some((row) => row.model === model)) continue;
    // No observation established a driver; an instance id is not a driver kind.
    models.push({ ...emptyTotals, model, driver: "" });
  }
  const countedThreads =
    request === undefined ? undefined : new Set([threadId, ...request.children]);
  // A request reads only its own threads' snapshots, and the lead's only from the request's
  // turns: a crew thread belongs to the request that started it, the lead outlives requests.
  const snapshots = yield* sql<ContextActivityRow>`
    SELECT
      t.thread_id AS "threadId",
      t.model_selection_json AS "modelSelectionJson",
      a.payload_json AS "payloadJson",
      a.created_at AS "createdAt"
    FROM projection_threads AS t
    JOIN projection_thread_activities AS a ON a.activity_id = (
      SELECT candidate.activity_id
      FROM projection_thread_activities AS candidate
      WHERE candidate.thread_id = t.thread_id AND candidate.kind = 'context-window.updated'
        ${
          request === undefined
            ? sql``
            : sql`AND (candidate.thread_id <> ${threadId} OR ${sql.in("candidate.turn_id", [...request.turnIds])})`
        }
      ORDER BY candidate.created_at DESC, candidate.sequence DESC, candidate.activity_id DESC
      LIMIT 1
    )
    WHERE ${
      countedThreads === undefined
        ? sql`t.thread_id = ${threadId} OR t.parent_thread_id = ${threadId}`
        : sql.in("t.thread_id", [...countedThreads])
    }
    LIMIT ${THREAD_USAGE_MAX_ROWS + 1}
  `;
  if (snapshots.length > THREAD_USAGE_MAX_ROWS)
    return { ...summary, status: "too-large" as const, totals: emptyTotals, models: [] };
  return {
    ...summary,
    models: attachModelContexts(models, snapshots, modelEvents, countedThreads),
  };
});
