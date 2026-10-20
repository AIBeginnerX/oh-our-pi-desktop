// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";
import {
  ProviderSafetyObservations,
  layer as observationsLayer,
} from "./ProviderSafetyObservations.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "./Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "./Layers/OrchestrationCommandReceipts.ts";
import { ServerConfig } from "../config.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import * as RestartContinuations from "../restartContinuations.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";

const at = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("safety-thread");
const otherThreadId = ThreadId.make("other-thread");
const turnId = TurnId.make("safety-turn");
const otherTurnId = TurnId.make("other-turn");

function withFileDatabase<A, E, R>(
  effect: Effect.Effect<A, E, R | ProviderSafetyObservations | SqlClient.SqlClient>,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-safety-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return effect.pipe(
    Effect.provide(
      observationsLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath }))),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const record = (
  observations: ProviderSafetyObservations["Service"],
  eventId: string,
  options: {
    threadId?: ThreadId;
    turnId?: TurnId | null;
    kind?: "tool.started" | "approval.requested" | "user-input.requested";
  } = {},
) =>
  observations.record({
    threadId: options.threadId ?? threadId,
    turnId: options.turnId === undefined ? turnId : options.turnId,
    eventId: EventId.make(eventId),
    kind: options.kind ?? "tool.started",
  });

const countForThread = (sql: SqlClient.SqlClient, id: ThreadId) =>
  sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM provider_safety_observations WHERE thread_id = ${id}
  `.pipe(Effect.map((rows) => rows[0]?.count ?? -1));

const insertActivity = (
  sql: SqlClient.SqlClient,
  eventId: string,
  options: {
    threadId?: ThreadId;
    turnId?: TurnId | null;
    kind?: "tool.started" | "approval.requested" | "user-input.requested";
  } = {},
) => sql`
  INSERT INTO projection_thread_activities (
    activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
  ) VALUES (
    ${eventId}, ${options.threadId ?? threadId},
    ${options.turnId === undefined ? turnId : options.turnId},
    'tool', ${options.kind ?? "tool.started"}, 'observed', '{}', ${at}
  )
`;

const insertThread = (sql: SqlClient.SqlClient, id: ThreadId) => sql`
  INSERT INTO projection_threads (
    thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at
  ) VALUES (
    ${id}, 'project-1', 'Existing thread',
    '{"instanceId":"claudeAgent","model":"claude-opus"}', 'full-access', ${at}, ${at}
  )
`;

it.effect("migration 55 preserves existing rows and installs the observation schema", () =>
  withFileDatabase(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* insertThread(sql, threadId);
      yield* insertActivity(sql, "preexisting-activity");

      yield* runMigrations({ toMigrationInclusive: 55 });

      const threads = yield* sql<{ readonly title: string }>`
        SELECT title FROM projection_threads WHERE thread_id = ${threadId}
      `;
      const activities = yield* sql<{ readonly activityId: string }>`
        SELECT activity_id AS "activityId" FROM projection_thread_activities
        WHERE activity_id = 'preexisting-activity'
      `;
      assert.deepEqual([...threads], [{ title: "Existing thread" }]);
      assert.deepEqual([...activities], [{ activityId: "preexisting-activity" }]);

      const table = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'provider_safety_observations'
      `;
      const columns = yield* sql<{ readonly name: string; readonly pk: number }>`
        PRAGMA table_info(provider_safety_observations)
      `;
      const index = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name = 'idx_pso_thread_turn'
      `;
      const triggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'trigger' AND tbl_name = 'projection_threads'
          AND sql LIKE '%provider_safety_observations%'
      `;
      assert.equal(table.length, 1);
      assert.deepEqual(
        columns.map((column) => column.name),
        ["thread_id", "event_id", "turn_id", "kind", "observed_at"],
      );
      assert.deepEqual(
        columns.filter((column) => column.pk > 0).map((column) => column.name),
        ["thread_id", "event_id"],
      );
      assert.equal(index.length, 1);
      assert.equal(triggers.length, 3);
      const foreignKeys = yield* sql`PRAGMA foreign_key_list(provider_safety_observations)`;
      assert.equal(foreignKeys.length, 0);

      const observations = yield* ProviderSafetyObservations;
      yield* record(observations, "after-upgrade");
      assert.equal(yield* countForThread(sql, threadId), 1);
    }),
  ),
);

it.effect("keeps the first observation when an event ID is inserted again", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      const observations = yield* ProviderSafetyObservations;
      const sql = yield* SqlClient.SqlClient;
      yield* record(observations, "immutable-event");
      yield* record(observations, "immutable-event");
      yield* record(observations, "immutable-event", {
        turnId: otherTurnId,
        kind: "approval.requested",
      });

      const rows = yield* sql<{
        readonly threadId: string;
        readonly eventId: string;
        readonly turnId: string | null;
        readonly kind: string;
      }>`
        SELECT thread_id AS "threadId", event_id AS "eventId",
          turn_id AS "turnId", kind
        FROM provider_safety_observations
      `;
      assert.deepEqual(
        [...rows],
        [
          {
            threadId,
            eventId: "immutable-event",
            turnId,
            kind: "tool.started",
          },
        ],
      );
    }),
  ),
);

it.effect("matches a projection only by thread, turn, event ID, and kind", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      const observations = yield* ProviderSafetyObservations;
      const sql = yield* SqlClient.SqlClient;
      const missing = () => observations.hasUnprojected({ threadId, turnId });
      yield* record(observations, "four-fields");
      assert.isTrue(yield* missing());

      yield* insertActivity(sql, "four-fields");
      assert.isFalse(yield* missing());

      yield* sql`UPDATE projection_thread_activities SET kind = 'approval.requested'
        WHERE activity_id = 'four-fields'`;
      assert.isTrue(yield* missing());
      yield* sql`UPDATE projection_thread_activities SET kind = 'tool.started', turn_id = ${otherTurnId}
        WHERE activity_id = 'four-fields'`;
      assert.isTrue(yield* missing());
      yield* sql`UPDATE projection_thread_activities SET turn_id = ${turnId}, thread_id = ${otherThreadId}
        WHERE activity_id = 'four-fields'`;
      assert.isTrue(yield* missing());
      yield* sql`UPDATE projection_thread_activities SET thread_id = ${threadId},
        activity_id = 'different-event' WHERE activity_id = 'four-fields'`;
      assert.isTrue(yield* missing());
      yield* sql`UPDATE projection_thread_activities SET activity_id = 'four-fields'
        WHERE activity_id = 'different-event'`;
      assert.isFalse(yield* missing());
    }),
  ),
);

it.effect("treats unmatched null-turn events as relevant and excludes other named turns", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      const observations = yield* ProviderSafetyObservations;
      const sql = yield* SqlClient.SqlClient;
      const currentMissing = () => observations.hasUnprojected({ threadId, turnId });
      yield* record(observations, "old-turn-only", { turnId: otherTurnId });
      assert.isFalse(yield* currentMissing());
      assert.isTrue(yield* observations.hasUnprojected({ threadId, turnId: otherTurnId }));

      yield* record(observations, "unknown-turn", { turnId: null, kind: "user-input.requested" });
      assert.isTrue(yield* currentMissing());
      assert.isTrue(yield* observations.hasUnprojected({ threadId, turnId: otherTurnId }));
      yield* insertActivity(sql, "unknown-turn", {
        turnId: null,
        kind: "user-input.requested",
      });
      assert.isFalse(yield* currentMissing());
      assert.isTrue(yield* observations.hasUnprojected({ threadId, turnId: otherTurnId }));
    }),
  ),
);

it.effect("checks beyond 600 projected observations without a row cap", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      const sql = yield* SqlClient.SqlClient;
      const observations = yield* ProviderSafetyObservations;
      yield* sql`
        WITH RECURSIVE n(i) AS (
          SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600
        )
        INSERT INTO provider_safety_observations (
          thread_id, event_id, turn_id, kind, observed_at
        )
        SELECT ${threadId}, printf('bulk-%04d', i), ${turnId}, 'tool.started', ${at}
        FROM n
      `;
      yield* sql`
        WITH RECURSIVE n(i) AS (
          SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600
        )
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at
        )
        SELECT printf('bulk-%04d', i), ${threadId}, ${turnId},
          'tool', 'tool.started', 'matched', '{}', ${at}
        FROM n
      `;
      assert.isFalse(yield* observations.hasUnprojected({ threadId, turnId }));
      yield* record(observations, "bulk-0601");
      assert.isTrue(yield* observations.hasUnprojected({ threadId, turnId }));
    }),
  ),
);

it.effect("clears observations on tombstone, recreate, and hard delete but not title update", () =>
  withFileDatabase(
    Effect.gen(function* () {
      yield* runMigrations();
      const observations = yield* ProviderSafetyObservations;
      const sql = yield* SqlClient.SqlClient;
      yield* insertThread(sql, threadId);
      yield* record(observations, "before-title");

      yield* sql`UPDATE projection_threads SET title = 'Renamed' WHERE thread_id = ${threadId}`;
      assert.equal(yield* countForThread(sql, threadId), 1);

      yield* sql`UPDATE projection_threads SET deleted_at = ${at} WHERE thread_id = ${threadId}`;
      assert.equal(yield* countForThread(sql, threadId), 0);

      yield* record(observations, "late-after-tombstone");
      assert.equal(yield* countForThread(sql, threadId), 1);
      yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      assert.equal(yield* countForThread(sql, threadId), 0);

      yield* record(observations, "before-hard-delete");
      yield* sql`DELETE FROM projection_threads WHERE thread_id = ${threadId}`;
      assert.equal(yield* countForThread(sql, threadId), 0);
    }),
  ),
);

it.effect("clears observations on real thread deletion and same-ID creation", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-safety-lifecycle-"));
  const persistence = makeSqlitePersistenceLive(NodePath.join(tempDir, "state.sqlite"));
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RestartContinuations.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(observationsLayer),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfig.layerTest(tempDir, tempDir)),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const observations = yield* ProviderSafetyObservations;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("safety-lifecycle-project");
    const modelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus",
    };
    const createThread = (commandId: string, title: string) =>
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(commandId),
        threadId,
        projectId,
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: at,
      });

    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make("safety-project-create"),
      projectId,
      title: "Safety lifecycle",
      workspaceRoot: tempDir,
      defaultModelSelection: modelSelection,
      createdAt: at,
    });
    yield* createThread("safety-thread-create-1", "First attempt");
    yield* record(observations, "before-real-delete");
    assert.equal(yield* countForThread(sql, threadId), 1);

    yield* engine.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("safety-thread-delete"),
      threadId,
    });
    assert.equal(yield* countForThread(sql, threadId), 0);

    yield* record(observations, "late-after-real-delete");
    assert.equal(yield* countForThread(sql, threadId), 1);
    yield* createThread("safety-thread-create-2", "Second attempt");
    assert.equal(yield* countForThread(sql, threadId), 0);
    const threads = yield* sql<{ readonly title: string; readonly deletedAt: string | null }>`
      SELECT title, deleted_at AS "deletedAt" FROM projection_threads WHERE thread_id = ${threadId}
    `;
    assert.deepEqual([...threads], [{ title: "Second attempt", deletedAt: null }]);
  }).pipe(
    Effect.provide(layer),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
