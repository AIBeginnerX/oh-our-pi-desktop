import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as OrchestrationCommandReceipts from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const layer = Layer.mergeAll(
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
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-receipt-pruning-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const DAY_MS = 86_400_000;
const NOW_MS = Date.parse("2026-03-01T00:00:00.000Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

describe("OrchestrationEngine receipt pruning", () => {
  effectIt.effect("prunes only old accepted receipts below the checkpoint and keeps dedupe", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;

      const projectCommand = {
        type: "project.create",
        commandId: CommandId.make("cmd-recent-project"),
        projectId: ProjectId.make("project-pruning"),
        title: "Project",
        workspaceRoot: "/tmp/project-pruning",
        createdAt: iso(NOW_MS),
      } as const;
      const first = yield* engine.dispatch(projectCommand);
      const checkpoint = yield* engine.latestSequence;

      const seed = (
        id: string,
        input: {
          readonly ageDays: number;
          readonly status: "accepted" | "rejected";
          readonly ahead?: boolean;
        },
      ) =>
        receipts.upsert({
          commandId: CommandId.make(id),
          aggregateKind: "thread",
          aggregateId: ThreadId.make("thread-pruning"),
          acceptedAt: iso(NOW_MS - input.ageDays * DAY_MS),
          resultSequence: input.ahead ? checkpoint + 100 : checkpoint,
          status: input.status,
          error: input.status === "rejected" ? "rejected" : null,
        });
      yield* seed("cmd-old-accepted", { ageDays: 400, status: "accepted" });
      yield* seed("cmd-recent-accepted", { ageDays: 3, status: "accepted" });
      yield* seed("cmd-old-rejected", { ageDays: 400, status: "rejected" });
      yield* seed("cmd-old-ahead", { ageDays: 400, status: "accepted", ahead: true });

      yield* seed("provider:old-accepted", { ageDays: 3, status: "accepted" });
      yield* seed("provider:recent-accepted", { ageDays: 0, status: "accepted" });
      yield* seed("provider:old-ahead", { ageDays: 3, status: "accepted", ahead: true });

      const present = (id: string) =>
        receipts.getByCommandId({ commandId: CommandId.make(id) }).pipe(Effect.map(Option.isSome));

      yield* TestClock.adjust("24 hours");
      for (let attempt = 0; attempt < 200 && (yield* present("cmd-old-accepted")); attempt += 1) {
        yield* Effect.yieldNow;
      }

      expect(yield* present("provider:old-accepted")).toBe(false);
      expect(yield* present("provider:recent-accepted")).toBe(true);
      expect(yield* present("provider:old-ahead")).toBe(true);
      expect(yield* present("cmd-old-accepted")).toBe(false);
      expect(yield* present("cmd-recent-accepted")).toBe(true);
      expect(yield* present("cmd-old-rejected")).toBe(true);
      expect(yield* present("cmd-old-ahead")).toBe(true);
      expect(yield* present("cmd-recent-project")).toBe(true);

      // A recent commandId is still deduplicated: replaying it neither
      // re-applies the command nor appends events.
      const replay = yield* engine.dispatch(projectCommand);
      expect(replay.sequence).toBe(first.sequence);
      expect(yield* engine.latestSequence).toBe(checkpoint);
    }).pipe(Effect.provide(layer)),
  );
});
