// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  CommandId,
  OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { isCrewMemberThread } from "@t3tools/shared/crew";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it } from "@effect/vitest";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
function makeOrchestrationLayer(databasePath?: string) {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
    Layer.provide(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

const threadJson = Schema.fromJsonString(Schema.toCodecJson(OrchestrationThread));

for (const { kind, title, renamedTitle, legacy, linked } of [
  { kind: "legacy-member", title: "Crew Worker · task", legacy: true },
  {
    kind: "renamed-legacy-member",
    title: "Crew Worker · task",
    renamedTitle: "Ordinary notes",
    legacy: true,
  },
  { kind: "ordinary", title: "Ordinary notes" },
  { kind: "renamed-ordinary", title: "Ordinary notes", renamedTitle: "Crew Worker · notes" },
  { kind: "linked-member", title: "Crew Worker · task", linked: true },
]) {
  it.effect(`rewind authority survives restart: ${kind}`, () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "crew-rewind-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      const databasePath = NodePath.join(directory, "state.sqlite");
      const threadId = ThreadId.make(kind);
      const projectId = ProjectId.make("project");
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("project"),
          projectId,
          title: "Project",
          workspaceRoot: directory,
          createdAt,
        });
        const threadDefaults = {
          projectId,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt,
        } satisfies Pick<
          OrchestrationThread,
          | "projectId"
          | "modelSelection"
          | "runtimeMode"
          | "interactionMode"
          | "branch"
          | "worktreePath"
          | "createdAt"
        >;
        const parentThreadId = ThreadId.make("parent");
        if (linked) {
          yield* engine.dispatch({
            ...threadDefaults,
            type: "thread.create",
            commandId: CommandId.make("create-parent"),
            threadId: parentThreadId,
            title: "Lead",
          });
        }
        yield* engine.dispatch({
          ...threadDefaults,
          type: "thread.create",
          commandId: CommandId.make(
            legacy ? `server:crew-create:${threadId}` : `create:${threadId}`,
          ),
          threadId,
          title,
          ...(linked ? { parentThreadId } : {}),
        });
        if (renamedTitle !== undefined) {
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("rename"),
            threadId,
            title: renamedTitle,
          });
        }
      }).pipe(Effect.provide(makeOrchestrationLayer(databasePath)));
      // A fresh layer reopens the persisted database after the first engine shuts down.
      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshot = yield* ProjectionSnapshotQuery;
        const detail = Option.getOrThrow(yield* snapshot.getThreadDetailSnapshot(threadId));
        const encodedThread = yield* Schema.encodeEffect(threadJson)(detail.thread);
        const wireThread = yield* Schema.decodeEffect(threadJson)(encodedThread);
        const webBlocksRewind = isCrewMemberThread(wireThread);
        const isMember = legacy === true || linked === true;
        for (const type of ["thread.conversation.revert", "thread.checkpoint.revert"] as const) {
          const before = yield* engine.latestSequence;
          const result = yield* engine
            .dispatch({ type, commandId: CommandId.make(type), threadId, turnCount: 0, createdAt })
            .pipe(Effect.result);
          expect.soft(webBlocksRewind).toBe(result._tag === "Failure");
          if (isMember) {
            expect.soft(result).toMatchObject({
              _tag: "Failure",
              failure: {
                detail:
                  "A crew member's conversation can't be rewound, because its crew task depends on those turns. Nothing was changed.",
              },
            });
            expect.soft(yield* Stream.runCollect(engine.readEvents(before))).toHaveLength(0);
          } else {
            expect(result).toMatchObject({ _tag: "Success" });
            expect(yield* Stream.runCollect(engine.readEvents(before))).toHaveLength(1);
          }
        }
      }).pipe(Effect.provide(makeOrchestrationLayer(databasePath)));
    }).pipe(Effect.scoped),
  );
}
