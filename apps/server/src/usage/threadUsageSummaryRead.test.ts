import { ThreadId, type ThreadUsageSummary } from "@t3tools/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { UsageService } from "./UsageService.ts";
import type { RateTable } from "./usagePricing.ts";
import {
  THREAD_USAGE_MAX_ROWS,
  deriveThreadUsageSummary,
  readThreadUsageSummary,
  type ThreadUsageModelEventRow,
} from "./threadUsageSummaryRead.ts";

const threadId = ThreadId.make("lead");

const observationJson = (): string =>
  JSON.stringify({
    v: 1,
    scope: "main-turn",
    terminal: "completed",
    source: {
      driver: "claudeAgent",
      instanceId: null,
      turnId: null,
      runtimeEventId: "event-1",
      nativeConversationId: null,
    },
    usage: {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 1000,
      outputTokens: 100,
    },
  });

const createdAt = "2026-01-01T00:00:00.000Z";

const insertThread = Effect.fn("test.insertThread")(function* (
  sql: SqlClient.SqlClient,
  id: string,
  parentThreadId: string | null,
) {
  yield* sql`
    INSERT INTO projection_threads (
      thread_id, project_id, title, model_selection_json, parent_thread_id, created_at, updated_at
    ) VALUES (
      ${id}, 'project-1', ${id}, '{"instanceId":"claude","model":"claude-opus-4-5"}',
      ${parentThreadId}, ${createdAt}, ${createdAt}
    )
  `;
});

const insertUsageActivity = Effect.fn("test.insertUsageActivity")(function* (
  sql: SqlClient.SqlClient,
  id: string,
  thread: string,
  payloadJson: string,
  at: string = createdAt,
) {
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, tone, kind, summary, payload_json, created_at
    ) VALUES (
      ${id}, ${thread}, 'neutral', 'owned-usage', '', ${payloadJson}, ${at}
    )
  `;
});

/** Raw event-store row; `streamVersion` must be unique per stream (unique index). */
const insertModelEvent = Effect.fn("test.insertModelEvent")(function* (
  sql: SqlClient.SqlClient,
  eventId: string,
  streamId: string,
  streamVersion: number,
  eventType: string,
  occurredAt: string,
  payloadJson: string,
) {
  yield* sql`
    INSERT INTO orchestration_events (
      event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
      actor_kind, payload_json, metadata_json
    ) VALUES (
      ${eventId}, 'thread', ${streamId}, ${streamVersion}, ${eventType}, ${occurredAt},
      'user', ${payloadJson}, '{}'
    )
  `;
});

const rates: RateTable = new Map([
  [
    "claude-opus-4-5",
    {
      inputCostPerToken: 10 / 1_000_000,
      outputCostPerToken: 20 / 1_000_000,
      cacheReadCostPerToken: 1 / 1_000_000,
      cacheCreationCostPerToken: 15 / 1_000_000,
      fastMultiplier: 1,
    },
  ],
  [
    "gpt-5.2",
    {
      inputCostPerToken: 30 / 1_000_000,
      outputCostPerToken: 60 / 1_000_000,
      cacheReadCostPerToken: 3 / 1_000_000,
      cacheCreationCostPerToken: 45 / 1_000_000,
      fastMultiplier: 1,
    },
  ],
]);

const modelSelection = (model: string): string => JSON.stringify({ instanceId: "claude", model });

/** Event payload with a per-thread or per-turn model selection. */
const modelSelectionEventPayload = (model: string): string =>
  `{"modelSelection":{"instanceId":"claude","model":"${model}"}}`;

const usageStub = Layer.succeed(UsageService, {
  readSummary: () => Effect.die("unused"),
  refreshRates: Effect.die("unused"),
  pricingTables: Effect.succeed({ rates, overrides: new Map() }),
});

const testLayers = Layer.provideMerge(usageStub, SqlitePersistenceMemory);

describe("readThreadUsageSummary", () => {
  it.effect(
    "aggregates a thread with its crew children, skipping undecodable rows and threads outside the family",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertThread(sql, "lead", null);
        yield* insertThread(sql, "child", "lead");
        yield* insertThread(sql, "other", null);
        yield* insertUsageActivity(sql, "lead-1", "lead", observationJson());
        yield* insertUsageActivity(sql, "child-1", "child", observationJson());
        yield* insertUsageActivity(sql, "child-2", "child", "{not json");
        yield* insertUsageActivity(sql, "other-1", "other", observationJson());
        yield* insertUsageActivity(sql, "ghost-1", "ghost", observationJson());

        const read = yield* readThreadUsageSummary(threadId);
        assert.strictEqual(read.status, "ok");
        expect(read.totals.turns).toBe(2);
        expect(read.models.map((row) => row.model)).toEqual(["claude-opus-4-5"]);
      }).pipe(Effect.provide(testLayers)),
  );

  it.effect(
    "attributes each usage row to the model its turn ran with through the real SQL path",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // The current selection is gpt-5.2; the events must decide attribution.
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, parent_thread_id, created_at, updated_at
          ) VALUES (
            'lead', 'project-1', 'lead', ${modelSelection("gpt-5.2")}, NULL, ${createdAt}, ${createdAt}
          )
        `;
        yield* insertThread(sql, "child", "lead");
        // Lead: created on claude-opus-4-5, one turn, switch to gpt-5.2, one
        // turn, then a per-turn override back to claude-opus-4-5.
        yield* insertModelEvent(
          sql,
          "ev-1",
          "lead",
          1,
          "thread.created",
          "2026-01-01T00:00:00.000Z",
          modelSelectionEventPayload("claude-opus-4-5"),
        );
        yield* insertModelEvent(
          sql,
          "ev-2",
          "lead",
          2,
          "thread.turn-start-requested",
          "2026-01-01T00:01:00.000Z",
          "{}",
        );
        yield* insertModelEvent(
          sql,
          "ev-3",
          "lead",
          3,
          "thread.meta-updated",
          "2026-01-01T00:02:00.000Z",
          modelSelectionEventPayload("gpt-5.2"),
        );
        yield* insertModelEvent(
          sql,
          "ev-4",
          "lead",
          4,
          "thread.turn-start-requested",
          "2026-01-01T00:03:00.000Z",
          "{}",
        );
        yield* insertModelEvent(
          sql,
          "ev-5",
          "lead",
          5,
          "thread.turn-start-requested",
          "2026-01-01T00:04:00.000Z",
          modelSelectionEventPayload("claude-opus-4-5"),
        );
        // Child: its own timeline must not pick up the lead's turns.
        yield* insertModelEvent(
          sql,
          "ev-6",
          "child",
          1,
          "thread.created",
          "2026-01-01T00:00:30.000Z",
          modelSelectionEventPayload("gpt-5.2"),
        );
        yield* insertModelEvent(
          sql,
          "ev-7",
          "child",
          2,
          "thread.turn-start-requested",
          "2026-01-01T00:03:30.000Z",
          "{}",
        );

        yield* insertUsageActivity(
          sql,
          "lead-turn-1",
          "lead",
          observationJson(),
          "2026-01-01T00:01:01.000Z",
        );
        yield* insertUsageActivity(
          sql,
          "lead-turn-2",
          "lead",
          observationJson(),
          "2026-01-01T00:03:01.000Z",
        );
        yield* insertUsageActivity(
          sql,
          "lead-turn-3",
          "lead",
          observationJson(),
          "2026-01-01T00:04:01.000Z",
        );
        yield* insertUsageActivity(
          sql,
          "child-turn-1",
          "child",
          observationJson(),
          "2026-01-01T00:03:31.000Z",
        );

        const read = yield* readThreadUsageSummary(threadId);
        assert.strictEqual(read.status, "ok");
        expect(read.totals.turns).toBe(4);
        // The usage query has no ORDER BY; sort on the model id instead of
        // relying on the row order the plan happens to produce.
        const modelRows = [...read.models].sort((a, b) => a.model.localeCompare(b.model));
        expect(modelRows.map((row) => row.model)).toEqual(["claude-opus-4-5", "gpt-5.2"]);
        expect(modelRows.map((row) => row.turns)).toEqual([2, 2]);
        expect(modelRows.map((row) => row.cost)).toEqual([
          { kind: "estimated", usd: expect.closeTo(0.024, 10) },
          { kind: "estimated", usd: expect.closeTo(0.072, 10) },
        ]);
      }).pipe(Effect.provide(testLayers)),
  );

  it.effect("reports too-large without numbers when the bounded query exceeds the row cap", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "lead", null);
      yield* sql`
          WITH RECURSIVE seq(i) AS (
            SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < ${THREAD_USAGE_MAX_ROWS + 1}
          )
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, tone, kind, summary, payload_json, created_at
          )
          SELECT 'flood-' || i, 'lead', 'neutral', 'owned-usage', '', '{broken', ${createdAt} FROM seq
        `;
      expect(yield* readThreadUsageSummary(threadId)).toEqual({
        threadId,
        status: "too-large",
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: { sum: 0, reportedTurns: 0 },
          cacheCreationTokens: { sum: 0, reportedTurns: 0 },
          turns: 0,
          cacheRate: null,
          cost: { kind: "unknown" },
        },
        models: [],
      });
    }).pipe(Effect.provide(testLayers)),
  );
});

describe("deriveThreadUsageSummary", () => {
  const row = (
    payloadJson = observationJson(),
    modelSelectionJson = '{"model":"claude-opus-4-5"}',
    at = createdAt,
  ) => ({
    threadId,
    modelSelectionJson,
    payloadJson,
    createdAt: at,
  });
  // Event rows in sequence order, as the bounded event query returns them.
  const modelEvent = (
    eventType: string,
    occurredAt: string,
    eventModel: string | null = null,
  ): ThreadUsageModelEventRow => ({
    streamId: threadId,
    eventType,
    occurredAt,
    eventModel,
  });
  const derive = (
    rows: ReadonlyArray<ReturnType<typeof row>>,
    maxRows: number,
    modelEvents: ReadonlyArray<ThreadUsageModelEventRow> = [],
  ) => deriveThreadUsageSummary(threadId, rows, rates, new Map(), maxRows, modelEvents);
  const estimatedUsd = (cost: ThreadUsageSummary["totals"]["cost"]): number =>
    cost.kind === "estimated" ? cost.usd : Number.NaN;

  it("treats exactly the cap as readable and one row past it as too-large", () => {
    expect(derive([row(), row()], 2).status).toBe("ok");
    expect(derive([row(), row(), row()], 2).status).toBe("too-large");
    expect(derive([row(), row(), row()], 2).totals.turns).toBe(0);
    expect(derive([row(), row(), row()], 2).models).toEqual([]);
  });

  it("skips rows whose payload or model selection cannot be read", () => {
    const read = derive(
      [row(), row("{broken"), row(observationJson(), "null"), row(observationJson(), "{}")],
      THREAD_USAGE_MAX_ROWS,
    );
    assert.strictEqual(read.status, "ok");
    expect(read.totals.turns).toBe(1);
  });

  it("attributes rows before and after a selection switch to their own models", () => {
    // Both rows carry the CURRENT selection (gpt-5.2); only the turn timeline
    // can tell that the first turn ran on claude-opus-4-5.
    const read = derive(
      [
        row(observationJson(), modelSelection("gpt-5.2"), "2026-01-01T00:01:01.000Z"),
        row(observationJson(), modelSelection("gpt-5.2"), "2026-01-01T00:03:01.000Z"),
      ],
      THREAD_USAGE_MAX_ROWS,
      [
        modelEvent("thread.created", "2026-01-01T00:00:00.000Z", "claude-opus-4-5"),
        modelEvent("thread.turn-start-requested", "2026-01-01T00:01:00.000Z"),
        modelEvent("thread.meta-updated", "2026-01-01T00:02:00.000Z", "gpt-5.2"),
        modelEvent("thread.turn-start-requested", "2026-01-01T00:03:00.000Z"),
      ],
    );
    assert.strictEqual(read.status, "ok");
    expect(read.totals.turns).toBe(2);
    expect(read.models.map((model) => model.model)).toEqual(["claude-opus-4-5", "gpt-5.2"]);
    expect(read.models.map((model) => model.turns)).toEqual([1, 1]);
    expect(read.models.map((model) => model.cost.kind)).toEqual(["estimated", "estimated"]);
    expect(estimatedUsd(read.models[0]!.cost)).toBeCloseTo(0.012, 10);
    expect(estimatedUsd(read.models[1]!.cost)).toBeCloseTo(0.036, 10);
    expect(estimatedUsd(read.totals.cost)).toBeCloseTo(0.048, 10);
  });

  it("lets a per-turn modelSelection override the thread selection for that turn only", () => {
    const read = derive(
      [
        row(observationJson(), modelSelection("claude-opus-4-5"), "2026-01-01T00:01:01.000Z"),
        row(observationJson(), modelSelection("claude-opus-4-5"), "2026-01-01T00:03:01.000Z"),
      ],
      THREAD_USAGE_MAX_ROWS,
      [
        modelEvent("thread.created", "2026-01-01T00:00:00.000Z", "claude-opus-4-5"),
        modelEvent("thread.turn-start-requested", "2026-01-01T00:01:00.000Z", "gpt-5.2"),
        modelEvent("thread.turn-start-requested", "2026-01-01T00:03:00.000Z"),
      ],
    );
    expect(read.models.map((model) => model.model)).toEqual(["gpt-5.2", "claude-opus-4-5"]);
    expect(read.models.map((model) => model.turns)).toEqual([1, 1]);
  });

  it("falls back to the current selection for rows predating every turn start", () => {
    const read = derive(
      [row(observationJson(), modelSelection("claude-opus-4-5"), "2026-01-01T00:01:01.000Z")],
      THREAD_USAGE_MAX_ROWS,
      [
        modelEvent("thread.created", "2026-01-01T00:05:00.000Z", "claude-opus-4-5"),
        modelEvent("thread.turn-start-requested", "2026-01-01T00:06:00.000Z", "gpt-5.2"),
      ],
    );
    expect(read.models.map((model) => model.model)).toEqual(["claude-opus-4-5"]);
    expect(read.totals.turns).toBe(1);
  });
});
