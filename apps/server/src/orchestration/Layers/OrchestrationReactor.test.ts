import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProviderCommandReactor } from "../Services/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import * as ThreadGoalReactor from "../ThreadGoalReactor.ts";
import * as ThreadSettlementReactor from "../ThreadSettlementReactor.ts";
import * as PullRequestSyncReactor from "../PullRequestSyncReactor.ts";
import * as ThreadPullRequestReactor from "../ThreadPullRequestReactor.ts";
import { OrchestrationReactor } from "../Services/OrchestrationReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { makeOrchestrationReactor } from "./OrchestrationReactor.ts";
import * as AgentAwarenessRelay from "../../relay/AgentAwarenessRelay.ts";
import { StorageCleanup } from "../../storageCleanup.ts";

describe("OrchestrationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<OrchestrationReactor, never> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  it("starts every orchestration reactor", async () => {
    const started: string[] = [];
    // The imported-title repair runs in the background once the server starts.
    let markTitleRepairRead = () => {};
    const titleRepairRead = new Promise<void>((resolve) => {
      markTitleRepairRead = resolve;
    });

    runtime = ManagedRuntime.make(
      Layer.effect(OrchestrationReactor, makeOrchestrationReactor).pipe(
        Layer.provideMerge(
          Layer.mock(ProjectionSnapshotQuery)({
            getShellSnapshot: () =>
              Effect.sync(markTitleRepairRead).pipe(
                Effect.as({
                  snapshotSequence: 0,
                  projects: [],
                  threads: [],
                  updatedAt: "2026-10-22T00:00:00.000Z",
                }),
              ),
          }),
        ),
        Layer.provideMerge(Layer.mock(OrchestrationEngineService)({})),
        Layer.provideMerge(
          Layer.succeed(
            Crypto.Crypto,
            Crypto.make({
              randomBytes: (size) => new Uint8Array(size).fill(1),
              digest: (_algorithm, data) => Effect.succeed(data),
            }),
          ),
        ),
        Layer.provideMerge(
          Layer.succeed(StorageCleanup, {
            start: () => {
              started.push("storage-cleanup");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderRuntimeIngestionService, {
            start: () => {
              started.push("provider-runtime-ingestion");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProviderCommandReactor, {
            start: () => {
              started.push("provider-command-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(CheckpointReactor, {
            start: () => {
              started.push("checkpoint-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadDeletionReactor, {
            start: () => {
              started.push("thread-deletion-reactor");
              return Effect.void;
            },
            drainThrough: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadPullRequestReactor.ThreadPullRequestReactor, {
            start: () => {
              started.push("thread-pull-request-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadSettlementReactor.ThreadSettlementReactor, {
            start: () => {
              started.push("thread-settlement-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ThreadGoalReactor.ThreadGoalReactor, {
            start: () => {
              started.push("thread-goal-reactor");
              return Effect.void;
            },
            drain: Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(PullRequestSyncReactor.PullRequestSyncReactor, {
            start: () => {
              started.push("pull-request-sync-reactor");
              return Effect.void;
            },
            drain: Effect.void,
            requestSync: () => Effect.void,
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(AgentAwarenessRelay.AgentAwarenessRelay, {
            publishThread: () => Effect.void,
            requestCatchUp: () => Effect.void,
            start: () => {
              started.push("agent-awareness-relay");
              return Effect.void;
            },
          }),
        ),
      ),
    );

    const reactor = await runtime!.runPromise(Effect.service(OrchestrationReactor));
    const scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));

    expect(started).toEqual([
      "provider-runtime-ingestion",
      "provider-command-reactor",
      "checkpoint-reactor",
      "thread-deletion-reactor",
      "thread-pull-request-reactor",
      "thread-settlement-reactor",
      "thread-goal-reactor",
      "pull-request-sync-reactor",
      "agent-awareness-relay",
      "storage-cleanup",
    ]);
    await titleRepairRead;

    await Effect.runPromise(Scope.close(scope, Exit.void));
  });
});
