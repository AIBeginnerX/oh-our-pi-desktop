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
  attachModelContexts,
  deriveThreadUsageSummary,
  readThreadUsageSummary,
  requestTurnIds,
  type ThreadUsageModelEventRow,
} from "./threadUsageSummaryRead.ts";

const threadId = ThreadId.make("lead");

const observationJson = (costUsd?: number): string =>
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
    ...(costUsd === undefined ? {} : { costUsd }),
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
  turnId: string | null = null,
) {
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
    ) VALUES (
      ${id}, ${thread}, ${turnId}, 'neutral', 'owned-usage', '', ${payloadJson}, ${at}
    )
  `;
});

/** A crew task's board row on the lead, naming the attempt thread it runs. */
const insertCrewTaskActivity = Effect.fn("test.insertCrewTaskActivity")(function* (
  sql: SqlClient.SqlClient,
  id: string,
  lead: string,
  kind: string,
  turnId: string | null,
  attemptThreadId: string,
) {
  yield* sql`
    INSERT INTO projection_thread_activities (
      activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
    ) VALUES (
      ${id}, ${lead}, ${turnId}, 'neutral', ${kind}, '',
      ${`{"taskId":"${id}","threadId":"${attemptThreadId}","status":"running"}`},
      ${createdAt}
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

describe("requestTurnIds", () => {
  const turns = [
    { turnId: "later", text: "Next request" },
    { turnId: "follow-up-2", text: '<oop_crew_follow_up round="2" fixes="0">' },
    { turnId: "wake", text: null },
    { turnId: "follow-up-1", text: '<oop_crew_follow_up round="1" fixes="0">' },
    { turnId: "user", text: "Start request" },
  ];

  it("includes follow-ups and wakes back through their user message", () => {
    expect(requestTurnIds(turns, "follow-up-2")).toEqual([
      "follow-up-2",
      "wake",
      "follow-up-1",
      "user",
    ]);
  });

  it("stops at a new user message", () => {
    expect(requestTurnIds(turns, "later")).toEqual(["later"]);
  });

  it("falls back to the named turn when it is absent", () => {
    expect(requestTurnIds(turns, "unknown")).toEqual(["unknown"]);
  });
});

describe("readThreadUsageSummary", () => {
  it.effect("includes crew and auditor models even before usage is reported", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "lead", null);
      for (const [id, model] of [
        ["worker", "deepseek"],
        ["auditor", "gpt-6.1-sol"],
      ]) {
        yield* insertThread(sql, id!, "lead");
        yield* sql`UPDATE projection_threads SET model_selection_json = ${modelSelection(model!)} WHERE thread_id = ${id}`;
        yield* insertCrewTaskActivity(sql, id!, "lead", "task.completed", "turn-1", id!);
      }
      const before = yield* readThreadUsageSummary(threadId, "turn-1");
      expect(before.models.map((row) => row.model).sort()).toEqual(["deepseek", "gpt-6.1-sol"]);
      expect(before.models.every((row) => row.cost.kind === "unknown")).toBe(true);
      yield* insertUsageActivity(
        sql,
        "auditor-usage",
        "auditor",
        observationJson(),
        createdAt,
        "audit-turn",
      );
      const after = yield* readThreadUsageSummary(threadId, "turn-1");
      expect(after.models.find((row) => row.model === "gpt-6.1-sol")?.inputTokens).toBe(1000);
      expect(after.models.filter((row) => row.model === "gpt-6.1-sol")).toHaveLength(1);
    }).pipe(Effect.provide(testLayers)),
  );

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

  it.effect(
    "reads the final wake turn with the request's lead and crew usage, excluding earlier requests",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* insertThread(sql, "lead", null);
        yield* insertThread(sql, "crew-child-1", "lead");
        yield* insertThread(sql, "crew-child-2", "lead");
        yield* insertThread(sql, "crew-child-3", "lead");
        yield* sql`
        UPDATE projection_threads SET model_selection_json = ${modelSelection("gpt-5.2")}
        WHERE thread_id IN ('crew-child-1', 'crew-child-2')
      `;
        const turns = [
          ["turn-1", createdAt, "Earlier request"],
          ["turn-2", "2026-01-01T00:02:00.000Z", "Current request"],
          ["follow-up", "2026-01-01T00:03:00.000Z", '<oop_crew_follow_up round="1" fixes="0">'],
          ["wake", "2026-01-01T00:04:00.000Z", null],
        ] as const;
        for (const [id, at, message] of turns) {
          const messageId = message === null ? null : `message-${id}`;
          if (messageId !== null)
            yield* sql`
              INSERT INTO projection_thread_messages (
                message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
              ) VALUES (${messageId}, 'lead', ${id}, 'user', ${message}, 0, ${at}, ${at})
            `;
          yield* sql`
            INSERT INTO projection_turns (
              thread_id, turn_id, pending_message_id, state, requested_at, checkpoint_files_json
            ) VALUES ('lead', ${id}, ${messageId}, 'completed', ${at}, '[]')
          `;
        }
        yield* insertUsageActivity(
          sql,
          "lead-wake",
          "lead",
          observationJson(),
          turns[3][1],
          "wake",
        );
        yield* insertUsageActivity(sql, "lead-t1", "lead", observationJson(), createdAt, "turn-1");
        yield* insertUsageActivity(
          sql,
          "lead-t2",
          "lead",
          observationJson(),
          "2026-01-01T00:02:01.000Z",
          "turn-2",
        );
        // The follow-up delegates a task whose attempt reports two usage rows.
        yield* insertCrewTaskActivity(
          sql,
          "task-start-2",
          "lead",
          "task.started",
          "follow-up",
          "crew-child-2",
        );
        yield* insertUsageActivity(
          sql,
          "child2-a",
          "crew-child-2",
          observationJson(),
          "2026-01-01T00:02:02.000Z",
          "child-turn-a",
        );
        yield* insertUsageActivity(
          sql,
          "child2-b",
          "crew-child-2",
          observationJson(),
          "2026-01-01T00:02:03.000Z",
          "child-turn-b",
        );
        // The first turn's own child task, a child no turn started, and a
        // lead row that names no turn: all stay out of the turn's summary.
        yield* insertCrewTaskActivity(
          sql,
          "task-start-1",
          "lead",
          "task.started",
          "turn-1",
          "crew-child-1",
        );
        yield* insertUsageActivity(
          sql,
          "child1",
          "crew-child-1",
          observationJson(),
          createdAt,
          "child-turn-1",
        );
        yield* insertUsageActivity(sql, "child3", "crew-child-3", observationJson(), createdAt);
        yield* insertUsageActivity(
          sql,
          "lead-null",
          "lead",
          observationJson(),
          "2026-01-01T00:02:04.000Z",
        );
        for (const [id, thread, turn, usedTokens, at] of [
          ["old", "crew-child-2", null, 90, "2026-01-01T00:03:02.000Z"],
          ["latest", "crew-child-2", null, 40, "2026-01-01T00:03:03.000Z"],
          ["earlier-request", "crew-child-1", null, 95, createdAt],
          // The lead reported its context only in the earlier request.
          ["lead-earlier", "lead", "turn-1", 70, createdAt],
        ] as const) {
          yield* sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
            ) VALUES (
              ${id}, ${thread}, ${turn}, 'neutral', 'context-window.updated', '',
              json_object('usedTokens', ${usedTokens}, 'maxTokens', 100), ${at}
            )
          `;
        }

        const read = yield* readThreadUsageSummary(threadId, "wake");
        assert.strictEqual(read.status, "ok");
        assert.strictEqual(read.scope, "turn");
        expect(read.totals.turns).toBe(4);
        expect(read.models.find((row) => row.model === "gpt-5.2")).toMatchObject({
          turns: 2,
          context: { usedTokens: 40, maxTokens: 100 },
        });
        // The lead's context from the earlier request is not this request's.
        expect(read.models.find((row) => row.model === "claude-opus-4-5")?.context).toBeUndefined();

        // Without a turn the same store still counts the whole family.
        const whole = yield* readThreadUsageSummary(threadId);
        assert.strictEqual(whole.scope, "thread");
        expect(whole.totals.turns).toBe(8);
        expect(whole.models.find((row) => row.model === "gpt-5.2")?.context).toEqual({
          usedTokens: 95,
          maxTokens: 100,
        });
        expect(whole.models.find((row) => row.model === "claude-opus-4-5")?.context).toEqual({
          usedTokens: 70,
          maxTokens: 100,
        });
      }).pipe(Effect.provide(testLayers)),
  );

  it.effect("prices the asked-for turn as its own step of the provider's running total", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, "lead", null);
      // One Claude chain across both turns: the second report repeats the
      // session's running total (5), not the turn's own cost (3).
      yield* insertUsageActivity(sql, "lead-t1", "lead", observationJson(2), createdAt, "turn-1");
      yield* insertUsageActivity(
        sql,
        "lead-t2",
        "lead",
        observationJson(5),
        "2026-01-01T00:01:01.000Z",
        "turn-2",
      );
      const read = yield* readThreadUsageSummary(threadId, "turn-2");
      assert.strictEqual(read.status, "ok");
      expect(read.totals.turns).toBe(1);
      expect(read.totals.cost).toEqual({ kind: "reported", usd: 3 });
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
        scope: "thread",
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
  const childThreadId = ThreadId.make("child");
  const row = (
    payloadJson = observationJson(),
    modelSelectionJson = '{"model":"claude-opus-4-5"}',
    at = createdAt,
    rowThreadId: ThreadId = threadId,
    turnId: string | null = null,
  ) => ({
    threadId: rowThreadId,
    turnId,
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

  it("counts request lead turns and crew children", () => {
    const earlierChild = ThreadId.make("earlier-child");
    const read = deriveThreadUsageSummary(
      threadId,
      [
        row(undefined, modelSelection("earlier"), createdAt, threadId, "earlier"),
        row(undefined, undefined, createdAt, threadId, "user"),
        row(undefined, undefined, createdAt, threadId, "follow-up"),
        row(undefined, modelSelection("crew"), createdAt, childThreadId),
        row(undefined, modelSelection("earlier"), createdAt, earlierChild),
      ],
      rates,
      new Map(),
      THREAD_USAGE_MAX_ROWS,
      [],
      { turnIds: new Set(["user", "follow-up"]), children: new Set([childThreadId]) },
    );
    expect(read.requestAggregated).toBe(true);
    expect(derive([row()], THREAD_USAGE_MAX_ROWS)).not.toHaveProperty("requestAggregated");
    expect(read.models.map(({ model, turns }) => [model, turns])).toEqual([
      ["claude-opus-4-5", 2],
      ["crew", 1],
    ]);
  });

  it("attaches the fullest counted context to the model active at the snapshot", () => {
    const models = derive([row(), row(undefined, modelSelection("gpt-5.2"))], 2).models;
    const snapshot = (id: ThreadId, model: string, usedTokens: number, maxTokens: number | null) =>
      row(JSON.stringify({ usedTokens, maxTokens }), modelSelection(model), createdAt, id);
    const secondChild = ThreadId.make("second-child");
    const thirdChild = ThreadId.make("third-child");
    const fourthChild = ThreadId.make("fourth-child");
    const attached = attachModelContexts(
      models,
      [
        snapshot(threadId, "gpt-5.2", 70, 100),
        snapshot(childThreadId, "claude-opus-4-5", 100, 200),
        snapshot(secondChild, "gpt-5.2", 120, null),
        snapshot(thirdChild, "gpt-5.2", 80, null),
        snapshot(fourthChild, "gpt-5.2", -1, null),
        snapshot(ThreadId.make("excluded"), "claude-opus-4-5", 99, 100),
      ],
      [modelEvent("thread.turn-start-requested", createdAt, "claude-opus-4-5")],
      new Set([threadId, childThreadId, secondChild, thirdChild, fourthChild]),
    );
    expect(attached.map(({ context }) => context)).toEqual([
      { usedTokens: 70, maxTokens: 100 },
      { usedTokens: 120, maxTokens: null },
    ]);
  });

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

  it("reads the provider's running total as per-turn cost across the thread family", () => {
    // The lead's reports repeat the session's whole spend: the chain's steps
    // (2 + 2) plus the child's own session (3) total 7, not the 16 the raw
    // reports sum to.
    const read = derive(
      [
        row(observationJson(2), modelSelection("gpt-5.2"), "2026-01-01T00:01:01.000Z"),
        row(observationJson(4), modelSelection("gpt-5.2"), "2026-01-01T00:03:01.000Z"),
        row(
          observationJson(),
          modelSelection("gpt-5.2"),
          "2026-01-01T00:03:31.000Z",
          childThreadId,
        ),
        row(
          observationJson(3),
          modelSelection("gpt-5.2"),
          "2026-01-01T00:03:32.000Z",
          childThreadId,
        ),
      ],
      THREAD_USAGE_MAX_ROWS,
    );
    assert.strictEqual(read.status, "ok");
    expect(read.totals.turns).toBe(4);
    expect(read.totals.cost).toEqual({ kind: "reported", usd: 7 });
    expect(read.models[0]!.cost).toEqual({ kind: "reported", usd: 7 });
  });
});
