import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionPipeline } from "../orchestration/Services/ProjectionPipeline.ts";
import { compactionPass } from "./EventStoreCompaction.ts";
import { OrchestrationEventStore } from "./Services/OrchestrationEventStore.ts";
import { OrchestrationEventStoreLive } from "./Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

// Every test pins the clock to NOW: OLD is past the age cutoff, YOUNG is not.
const OLD = "2026-01-01T00:00:00.000Z";
const NOW = Date.parse("2026-06-01T00:00:00.000Z");
const YOUNG = "2099-01-01T00:00:00.000Z";

const makeTestLayer = (prefix: string) =>
  OrchestrationProjectionPipelineLive.pipe(
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
    Layer.fresh,
  );

interface SeedEvent {
  readonly sequence: number;
  readonly type: string;
  readonly streamId: string;
  readonly occurredAt: string;
  readonly payloadJson: string;
}

interface ActivityRow {
  readonly activityId: string;
  readonly kind: string;
}

const toolActivity = (
  id: string,
  kind: string,
  turn: string,
  toolCallId: string | undefined,
  usedTokens?: number,
  createdAt?: string,
) => ({
  id,
  tone: "tool",
  kind,
  summary: kind === "context-window.updated" ? "Context" : "Tool",
  payload:
    usedTokens !== undefined
      ? { usedTokens }
      : toolCallId === undefined
        ? { title: "Fallback" }
        : { toolCallId },
  turnId: turn,
  createdAt,
});

/** Unless a test sets `createdAt`, activities are created in event order, one second apart. */
const activityEvent = (
  sequence: number,
  threadId: string,
  activity: ReturnType<typeof toolActivity>,
  occurredAt = OLD,
): SeedEvent => ({
  sequence,
  type: "thread.activity-appended",
  streamId: threadId,
  occurredAt,
  payloadJson: JSON.stringify({
    threadId,
    activity: {
      ...activity,
      createdAt:
        activity.createdAt ??
        DateTime.formatIso(DateTime.makeUnsafe(Date.parse(OLD) + sequence * 1000)),
    },
  }),
});

const threadCreated = (sequence: number, threadId: string, occurredAt = OLD): SeedEvent => ({
  sequence,
  type: "thread.created",
  streamId: threadId,
  occurredAt,
  payloadJson: JSON.stringify({
    threadId,
    projectId: "project-1",
    title: "Thread",
    modelSelection: { instanceId: "inst", model: "model" },
    branch: null,
    worktreePath: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }),
});

it.layer(makeTestLayer("t3-event-store-compaction"))("EventStoreCompaction", (it) => {
  const seedEvents = Effect.fn("seedEvents")(function* (
    sql: SqlClient.SqlClient,
    events: ReadonlyArray<SeedEvent>,
  ) {
    for (const event of events) {
      yield* sql`
        INSERT INTO orchestration_events (
          sequence, event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id, actor_kind,
          payload_json, metadata_json
        ) VALUES (
          ${event.sequence}, ${`evt-${event.sequence}`}, 'thread', ${event.streamId},
          ${event.sequence}, ${event.type}, ${event.occurredAt}, NULL, NULL, NULL, 'server',
          ${event.payloadJson}, '{}'
        )
      `;
    }
  });

  /**
   * Compaction only runs at or below the MIN projector cursor, so every test
   * that seeds events without bootstrapping raises the whole floor past them.
   */
  const seedCursor = (sql: SqlClient.SqlClient, sequence: number) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.test', ${sequence}, ${OLD})
        ON CONFLICT (projector)
        DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence
      `;
      yield* sql`
        UPDATE projection_state SET last_applied_sequence = ${sequence}
        WHERE last_applied_sequence < ${sequence}
      `;
    });

  const activityRows = (sql: SqlClient.SqlClient, threadId: string) =>
    sql<ActivityRow>`
      SELECT activity_id AS "activityId", kind FROM projection_thread_activities
      WHERE thread_id = ${threadId}
      ORDER BY activity_id
    `;

  const eventSequences = Effect.fn("eventSequences")(function* (
    sql: SqlClient.SqlClient,
    threadId: string,
  ) {
    const rows = yield* sql<{ readonly sequence: number }>`
      SELECT sequence FROM orchestration_events
      WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
      ORDER BY sequence
    `;
    return rows.map((row) => row.sequence);
  });

  it.effect("compaction keeps projections stable across a full rebuild", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const thread = "thread-compaction";
      yield* seedEvents(sql, [
        threadCreated(1, thread),
        // Call A completes: both earlier updates go, the one after stays.
        activityEvent(3, thread, toolActivity("a-update-1", "tool.updated", "turn-1", "A")),
        activityEvent(4, thread, toolActivity("a-update-2", "tool.updated", "turn-1", "A")),
        activityEvent(5, thread, toolActivity("a-complete", "tool.completed", "turn-1", "A")),
        activityEvent(6, thread, toolActivity("a-update-after", "tool.updated", "turn-1", "A")),
        // Call B never completes: in-flight state must survive.
        activityEvent(7, thread, toolActivity("b-started", "tool.started", "turn-1", "B")),
        activityEvent(8, thread, toolActivity("b-update", "tool.updated", "turn-1", "B")),
        // Only the newest resolvable context meter per turn is visible; an
        // unresolvable row passes through, a young row waits for the cutoff.
        activityEvent(
          9,
          thread,
          toolActivity("ctx-unresolvable", "context-window.updated", "turn-1", undefined),
        ),
        activityEvent(
          10,
          thread,
          toolActivity("ctx-stale", "context-window.updated", "turn-1", undefined, 2000),
        ),
        activityEvent(
          11,
          thread,
          toolActivity("ctx-latest", "context-window.updated", "turn-1", undefined, 3000),
        ),
        activityEvent(
          12,
          thread,
          toolActivity("ctx-young", "context-window.updated", "turn-2", undefined, 4000, YOUNG),
        ),
        // A young superseded update waits for the age cutoff.
        activityEvent(
          13,
          thread,
          toolActivity("a-update-young", "tool.updated", "turn-1", "A"),
          YOUNG,
        ),
      ]);

      yield* pipeline.bootstrap;
      const baseline = yield* activityRows(sql, thread);
      // The projector already dropped the two updates call A's completion supersedes.
      assert.equal(baseline.length, 9);

      const result = yield* compactionPass();
      assert.equal(result.supersededToolUpdatedEvents, 2);
      assert.equal(result.staleContextWindowEvents, 1);

      const surviving = yield* eventSequences(sql, thread);
      assert.deepEqual(surviving, [1, 5, 6, 7, 8, 9, 11, 12, 13]);

      const droppedActivityIds = new Set(["a-update-1", "a-update-2", "ctx-stale"]);
      const expected = baseline.filter((row) => !droppedActivityIds.has(row.activityId));

      yield* sql`UPDATE projection_state SET last_applied_sequence = 0`;
      yield* pipeline.bootstrap;
      const rebuilt = yield* activityRows(sql, thread);
      assert.deepEqual(rebuilt, expected);
    }),
  );

  it.effect("catch-up replays tolerate the compacted sequence gaps", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      const store = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const thread = "thread-catchup";
      yield* seedEvents(sql, [
        threadCreated(20, thread),
        activityEvent(21, thread, toolActivity("c-update-1", "tool.updated", "turn-1", "C")),
        activityEvent(22, thread, toolActivity("c-complete", "tool.completed", "turn-1", "C")),
        activityEvent(23, thread, toolActivity("c-update-2", "tool.updated", "turn-1", "C")),
        activityEvent(
          24,
          thread,
          toolActivity("c-ctx-1", "context-window.updated", "turn-1", undefined, 100),
        ),
        activityEvent(
          25,
          thread,
          toolActivity("c-ctx-2", "context-window.updated", "turn-1", undefined, 200),
        ),
      ]);
      yield* pipeline.bootstrap;

      const result = yield* compactionPass();
      assert.equal(result.supersededToolUpdatedEvents, 1);
      assert.equal(result.staleContextWindowEvents, 1);

      const head = 25;
      const replayed = Array.from(
        yield* Stream.runCollect(
          store.readAggregateRange({
            aggregateKind: "thread",
            aggregateId: thread,
            fromSequenceExclusive: 19,
            toSequenceInclusive: head,
            limit: 1_000,
          }),
        ),
      );
      // The pruned events leave gaps a cursor-spanning subscriber sees as
      // missing sequence numbers; order and the surviving tail stay intact.
      assert.deepEqual(
        replayed.map((event) => event.sequence),
        [20, 22, 23, 25],
      );
      const stats = yield* store.getAggregateReplayStats({
        aggregateKind: "thread",
        aggregateId: thread,
        fromSequenceExclusive: 19,
        toSequenceInclusive: head,
        maxEvents: 1_000,
      });
      assert.equal(stats.eventCount, 4);
      assert.isTrue(stats.hasCreateEvent);
    }),
  );

  it.effect("deletes in bounded batches until the redundant set is gone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      const thread = "thread-batching";
      yield* seedEvents(sql, [
        threadCreated(40, thread),
        activityEvent(41, thread, toolActivity("d-update-1", "tool.updated", "turn-1", "D")),
        activityEvent(42, thread, toolActivity("d-update-2", "tool.updated", "turn-1", "D")),
        activityEvent(43, thread, toolActivity("d-update-3", "tool.updated", "turn-1", "D")),
        activityEvent(44, thread, toolActivity("d-update-4", "tool.updated", "turn-1", "D")),
        activityEvent(45, thread, toolActivity("d-update-5", "tool.updated", "turn-1", "D")),
        activityEvent(46, thread, toolActivity("d-complete", "tool.completed", "turn-1", "D")),
      ]);
      yield* seedCursor(sql, 46);

      const result = yield* compactionPass({ batchSize: 2 });
      assert.equal(result.supersededToolUpdatedEvents, 5);
      // Five event deletes, two sequences per batch.
      assert.equal(result.batches, 3);
      const surviving = yield* eventSequences(sql, thread);
      assert.deepEqual(surviving, [40, 46]);
    }),
  );

  it.effect("keeps events a lagging projector has not applied yet", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      const thread = "thread-lagging";
      yield* seedEvents(sql, [
        threadCreated(50, thread),
        activityEvent(51, thread, toolActivity("l-update", "tool.updated", "turn-1", "L")),
        activityEvent(52, thread, toolActivity("l-complete", "tool.completed", "turn-1", "L")),
      ]);
      yield* seedCursor(sql, 52);
      // One projector still sits before the completion that supersedes the update.
      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('projection.lagging', 51, ${OLD})
      `;
      const lagging = yield* compactionPass();
      assert.equal(lagging.supersededToolUpdatedEvents, 0);
      assert.deepEqual(yield* eventSequences(sql, thread), [50, 51, 52]);

      yield* sql`DELETE FROM projection_state WHERE projector = 'projection.lagging'`;
      const caughtUp = yield* compactionPass();
      assert.equal(caughtUp.supersededToolUpdatedEvents, 1);
      assert.deepEqual(yield* eventSequences(sql, thread), [50, 52]);
    }),
  );

  it.effect("follows the read path's activity order, not event order", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const thread = "thread-activity-order";
      const JAN_1 = "2026-01-01T12:00:00.000Z";
      const JAN_2 = "2026-01-02T12:00:00.000Z";
      yield* seedEvents(sql, [
        threadCreated(60, thread),
        // The meter written first was created later, so the read path shows it.
        activityEvent(
          61,
          thread,
          toolActivity("m-shown", "context-window.updated", "turn-1", undefined, 200, JAN_2),
        ),
        activityEvent(
          62,
          thread,
          toolActivity("m-older", "context-window.updated", "turn-1", undefined, 100, JAN_1),
        ),
        // An update created after its call's completion is not superseded by it.
        activityEvent(
          63,
          thread,
          toolActivity("t-update", "tool.updated", "turn-1", "T", undefined, JAN_2),
        ),
        activityEvent(
          64,
          thread,
          toolActivity("t-complete", "tool.completed", "turn-1", "T", undefined, JAN_1),
        ),
      ]);
      yield* pipeline.bootstrap;
      yield* seedCursor(sql, 64);
      const visible = Effect.gen(function* () {
        const rows = yield* sql<{
          readonly activityId: string;
          readonly usedTokens: number | null;
        }>`
          SELECT activity_id AS "activityId", json_extract(payload_json, '$.usedTokens') AS "usedTokens"
          FROM projection_thread_activities WHERE thread_id = ${thread}
          ORDER BY activity_id
        `;
        return rows;
      });
      const before = yield* visible;
      assert.deepEqual(
        before.map((row) => row.activityId),
        ["m-older", "m-shown", "t-complete", "t-update"],
      );

      const result = yield* compactionPass();
      assert.equal(result.supersededToolUpdatedEvents, 0);
      assert.equal(result.staleContextWindowEvents, 1);
      assert.deepEqual(yield* eventSequences(sql, thread), [60, 61, 63, 64]);

      // A rebuild from the compacted events shows the same meter and update.
      yield* sql`UPDATE projection_state SET last_applied_sequence = 0`;
      yield* pipeline.bootstrap;
      const rebuilt = yield* visible;
      assert.deepEqual(rebuilt, [
        { activityId: "m-shown", usedTokens: 200 },
        { activityId: "t-complete", usedTokens: null },
        { activityId: "t-update", usedTokens: null },
      ]);
    }),
  );

  it.effect("finds superseded updates whose completion lies in a later window", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW);
      const sql = yield* SqlClient.SqlClient;
      const thread = "thread-windows";
      // Windows of 6 start at the first stored sequence and advance by 3. Put
      // the pair across the edge between back-to-back windows, where only the
      // overlapping window sees both events.
      const firstRows = yield* sql<{ readonly first: number }>`
        SELECT MIN(sequence) AS "first" FROM orchestration_events
      `;
      const base = (firstRows[0]?.first ?? 1) + 6 * 30 + 3;
      yield* seedEvents(sql, [
        threadCreated(base, thread),
        activityEvent(base + 1, thread, toolActivity("w-update-1", "tool.updated", "turn-1", "W")),
        activityEvent(base + 2, thread, toolActivity("w-update-2", "tool.updated", "turn-1", "W")),
        activityEvent(base + 3, thread, toolActivity("x-started", "tool.started", "turn-1", "X")),
        activityEvent(
          base + 4,
          thread,
          toolActivity("w-complete", "tool.completed", "turn-1", "W"),
        ),
      ]);
      yield* seedCursor(sql, base + 4);
      const result = yield* compactionPass({ windowSize: 6 });
      assert.equal(result.supersededToolUpdatedEvents, 2);
      assert.deepEqual(yield* eventSequences(sql, thread), [base, base + 3, base + 4]);
    }),
  );
});
