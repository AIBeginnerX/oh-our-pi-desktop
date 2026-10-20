// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { describe, expect } from "vite-plus/test";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { layer as ProjectMemorySendLedgerLayer } from "../../persistence/ProjectMemorySendLedger.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import {
  ProjectSkillMutationFence,
  layer as ProjectSkillMutationFenceLayer,
} from "../../skills/ProjectSkillMutationFence.ts";
import { ServerConfig } from "../../config.ts";
import { layer as ServerSettingsLayer } from "../../serverSettings.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex");

type PostCommitGate = {
  current:
    | undefined
    | {
        readonly entered: Deferred.Deferred<void>;
        readonly release: Deferred.Deferred<void>;
      };
};

const withPostCommitTransactionGate = (
  sql: SqlClient.SqlClient,
  gate: PostCommitGate,
): SqlClient.SqlClient =>
  new Proxy(sql, {
    apply(target, thisArg, args) {
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop === "withTransaction") {
        return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            const existingTransaction = yield* Effect.serviceOption(target.transactionService);
            const value = yield* target.withTransaction(effect);
            const active = gate.current;
            if (Option.isNone(existingTransaction) && active !== undefined) {
              yield* Deferred.succeed(active.entered, undefined);
              yield* Deferred.await(active.release);
            }
            return value;
          });
      }
      return Reflect.get(target, prop, receiver);
    },
  });

const makePostCommitTransactionLayer = (gate: PostCommitGate) =>
  Layer.effect(
    SqlClient.SqlClient,
    Effect.map(SqlClient.SqlClient, (sql) => {
      const decorated = withPostCommitTransactionGate(sql, gate);
      expect(decorated.transactionService).toBe(sql.transactionService);
      return decorated;
    }),
  );

const makePersistenceWithPostCommit = (databasePath: string, gate: PostCommitGate) =>
  makePostCommitTransactionLayer(gate).pipe(Layer.provide(makeSqlitePersistenceLive(databasePath)));

function makeSharedFenceLayer(databasePath?: string) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-skill-fence-test-",
  });
  const engineLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provideMerge(ProjectMemorySendLedgerLayer),
  );
  const settingsLayer = ServerSettingsLayer.pipe(Layer.provide(ServerSecretStore.layer));
  return engineLayer.pipe(
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(ProjectSkillMutationFenceLayer),
    Layer.provide(persistence),
    Layer.provideMerge(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

describe("OrchestrationEngine skill lifecycle fence", () => {
  const seed = (
    engine: OrchestrationEngineShape,
    prefix: string,
    projectId: ProjectId,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${prefix}-project`),
        projectId,
        title: "Fence project",
        workspaceRoot: `/tmp/${prefix}`,
        createdAt: NOW,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${prefix}-thread`),
        threadId,
        projectId,
        title: "Fence thread",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
      });
    });

  it.effect("invalidates the same project's token after a fenced writer commits", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const fence = yield* ProjectSkillMutationFence;
      const projectId = ProjectId.make("project-skill-fence");
      const otherProjectId = ProjectId.make("project-skill-fence-other");
      const threadId = ThreadId.make("thread-skill-fence");
      yield* seed(engine, "skill-fence", projectId, threadId);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("skill-fence-other-project"),
        projectId: otherProjectId,
        title: "Other",
        workspaceRoot: "/tmp/other",
        createdAt: NOW,
      });

      const token = fence.acquire(projectId);
      const otherToken = fence.acquire(otherProjectId);
      expect(token).toBeDefined();
      expect(otherToken).toBeDefined();

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("skill-fence-scripts"),
        projectId,
        scripts: [
          {
            id: "lint",
            name: "Lint",
            command: "pnpm lint",
            icon: "lint",
            runOnWorktreeCreate: false,
          },
        ],
      });

      expect(fence.holds(token!)).toBe(false);
      expect(fence.holds(otherToken!)).toBe(true);

      yield* engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("skill-fence-title-only"),
        threadId,
        title: "Renamed only",
      });
      const afterTitle = fence.acquire(projectId);
      expect(afterTitle).toBeDefined();
      expect(fence.holds(afterTitle!)).toBe(true);
    }).pipe(Effect.provide(makeSharedFenceLayer())),
  );

  it.effect("keeps project pending through post-commit publication", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skill-fence-postcommit-")),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const gate: PostCommitGate = { current: undefined };
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "t3-skill-fence-postcommit-",
      });
      const layer = OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
        Layer.provideMerge(ThreadBackgroundLiveness.layer),
        Layer.provide(ThreadPlanProgress.layer),
        Layer.provideMerge(restartContinuationsLayer),
        Layer.provide(OrchestrationEventStoreLive),
        Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
        Layer.provide(RepositoryIdentityResolver.layer),
        Layer.provideMerge(ProjectionTurnRepositoryLive),
        Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
        Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
        Layer.provideMerge(ProjectMemorySendLedgerLayer),
        Layer.provideMerge(ProjectSkillMutationFenceLayer),
        Layer.provideMerge(makePersistenceWithPostCommit(databasePath, gate)),
        Layer.provideMerge(serverConfigLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const fence = yield* ProjectSkillMutationFence;
        const sql = yield* SqlClient.SqlClient;
        const projectId = ProjectId.make("project-postcommit");
        const threadId = ThreadId.make("thread-postcommit");
        yield* seed(engine, "postcommit", projectId, threadId);
        const head = yield* engine.latestSequence;
        const token = fence.acquire(projectId);
        expect(token).toBeDefined();
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        gate.current = { entered, release };
        const dispatch = yield* engine
          .dispatch({
            type: "thread.runtime-mode.set",
            commandId: CommandId.make("postcommit-runtime"),
            threadId,
            runtimeMode: "full-access",
            createdAt: NOW,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        const tail = yield* engine.latestSequence;
        expect(tail).toBe(head);
        const rows = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS "count" FROM orchestration_events WHERE sequence > ${head}
        `;
        expect(rows[0]?.count).toBeGreaterThan(0);
        expect(fence.snapshotCounters().projectPending(projectId)).toBe(1);
        expect(fence.holds(token!)).toBe(false);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(dispatch);
        expect(yield* engine.latestSequence).toBeGreaterThan(head);
        expect(fence.snapshotCounters().projectPending(projectId)).toBe(0);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("engine dispatch and settings update share one memoized fence instance", () =>
    Effect.gen(function* () {
      const fence = yield* ProjectSkillMutationFence;
      const engine = yield* OrchestrationEngineService;
      const settings = yield* ServerSettingsService;
      const projectId = ProjectId.make("project-shared-fence");
      const threadId = ThreadId.make("thread-shared-fence");
      yield* seed(engine, "shared-fence", projectId, threadId);

      const globalBefore = fence.snapshotCounters().globalRevision;
      const token = fence.acquire(projectId);
      expect(token).toBeDefined();

      yield* engine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make("shared-fence-scripts"),
        projectId,
        scripts: [
          {
            id: "lint",
            name: "Lint",
            command: "pnpm lint",
            icon: "lint",
            runOnWorktreeCreate: false,
          },
        ],
      });
      expect(fence.holds(token!)).toBe(false);
      expect(fence.snapshotCounters().globalRevision).toBe(globalBefore);

      yield* settings.updateSettings({ deviceOnboardingCompleted: true });
      expect(fence.snapshotCounters().globalRevision).toBe(globalBefore);

      yield* settings.updateSettings({
        defaultProjectScripts: [
          {
            id: "fmt",
            name: "Format",
            command: "pnpm fmt",
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ],
      });
      expect(fence.snapshotCounters().globalRevision).toBeGreaterThan(globalBefore);
    }).pipe(Effect.provide(makeSharedFenceLayer())),
  );
});
