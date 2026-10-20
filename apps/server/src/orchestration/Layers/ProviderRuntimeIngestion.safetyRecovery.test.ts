// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { layer as projectMemorySendGateLayer } from "../../memory/ProjectMemorySendGate.ts";
import { layer as restartContinuationsLayer } from "../../restartContinuations.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { layer as projectMemorySendLedgerLayer } from "../../persistence/ProjectMemorySendLedger.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as ProviderSafetyObservations from "../../persistence/ProviderSafetyObservations.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import type { ProviderAdapterShape } from "../../provider/Services/ProviderAdapter.ts";
import type { ProviderAdapterError } from "../../provider/Errors.ts";
import * as ProviderAdapterRegistry from "../../provider/Services/ProviderAdapterRegistry.ts";
import { makeAdapterRegistryMock } from "../../provider/testUtils/providerAdapterRegistryMock.ts";
import { makeProviderServiceLive } from "../../provider/Layers/ProviderService.ts";
import * as ProviderEventLoggers from "../../provider/Layers/ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "../../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionDirectory from "../../provider/Services/ProviderSessionDirectory.ts";
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as ServerRuntimeStartup from "../../serverRuntimeStartup.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";

const provider = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const projectId = ProjectId.make("e11-project");
const threadId = ThreadId.make("e11-thread");
const turnId = TurnId.make("e11-old-turn");
const at = "2026-01-01T00:00:00.000Z";

describe("E11 safety recovery contract", () => {
  for (const variant of [
    "tool-blocked",
    "approval-blocked",
    "approval-resolved",
    "user-input-blocked",
    "user-input-resolved",
    "tool-completed",
    "null-turn-unmatched",
    "old-turn-unmatched",
    "assistant-blocked",
    "drained",
  ] as const) {
    it.live(variant, () =>
      Effect.gen(function* () {
        const blockedSafety =
          variant === "tool-blocked" ||
          variant === "approval-blocked" ||
          variant === "user-input-blocked";
        const completedToolControl =
          variant === "tool-completed" ||
          variant === "null-turn-unmatched" ||
          variant === "old-turn-unmatched";
        const resolvedRequestControl =
          variant === "approval-resolved" || variant === "user-input-resolved";
        const expectsBlocked = blockedSafety || variant === "null-turn-unmatched";
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `e11-${variant}-`));
        const dbPath = NodePath.join(dir, "live.sqlite");
        const snapshotPath = NodePath.join(dir, "crash-snapshot.sqlite");
        const bus = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 10 });
        const ingestionSubscribed = yield* Deferred.make<void>();
        const sessions = new Map<ThreadId, ProviderSession>();
        const cursorB = yield* Deferred.make<void>();
        type Gate = {
          entered: Deferred.Deferred<void>;
          release: Deferred.Deferred<void>;
        };
        let gate: Gate | null = null;
        const gates: Gate[] = [];
        let itemGate: Gate | null = null;
        const arm = Effect.gen(function* () {
          const next = {
            entered: yield* Deferred.make<void>(),
            release: yield* Deferred.make<void>(),
          };
          gate = next;
          gates.push(next);
          return next;
        });

        const fakeAdapter = {
          provider,
          capabilities: { sessionModelSwitch: "in-session" as const },
          startSession: (input) =>
            Effect.sync(() => {
              const session: ProviderSession = {
                provider,
                providerInstanceId: instanceId,
                threadId: input.threadId,
                status: "ready",
                runtimeMode: input.runtimeMode,
                resumeCursor: { resume: "native-session", resumeSessionAt: "A" },
                cwd: input.cwd,
                createdAt: at,
                updatedAt: at,
              };
              sessions.set(input.threadId, session);
              return session;
            }),
          sendTurn: (input) => Effect.succeed({ threadId: input.threadId, turnId }),
          interruptTurn: () => Effect.void,
          respondToRequest: () => Effect.void,
          respondToUserInput: () => Effect.void,
          stopSession: (id) =>
            Effect.sync(() => {
              sessions.delete(id);
            }),
          listSessions: () => Effect.sync(() => [...sessions.values()]),
          hasSession: (id) => Effect.sync(() => sessions.has(id)),
          readThread: (id) => Effect.succeed({ threadId: id, turns: [] }),
          rollbackThread: (id) => Effect.succeed({ threadId: id, turns: [] }),
          stopAll: () =>
            Effect.sync(() => {
              sessions.clear();
            }),
          get streamEvents() {
            return Stream.fromPubSub(bus);
          },
        } satisfies ProviderAdapterShape<ProviderAdapterError>;
        const emit = (event: ProviderRuntimeEvent) => PubSub.publish(bus, event);
        const base = { provider, threadId, turnId, createdAt: at };

        const persistence = makeSqlitePersistenceLive(dbPath);
        const observationsLayer = ProviderSafetyObservations.layer.pipe(Layer.provide(persistence));
        const directoryLive = ProviderSessionDirectoryLive.pipe(
          Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(persistence))),
        );
        const directory = Layer.effect(
          ProviderSessionDirectory.ProviderSessionDirectory,
          Effect.gen(function* () {
            const service = yield* ProviderSessionDirectory.ProviderSessionDirectory;
            return ProviderSessionDirectory.ProviderSessionDirectory.of({
              ...service,
              upsert: (binding, options) =>
                service
                  .upsert(binding, options)
                  .pipe(
                    Effect.tap(() =>
                      binding.resumeCursor &&
                      (binding.resumeCursor as { resumeSessionAt?: string }).resumeSessionAt === "B"
                        ? Deferred.succeed(cursorB, undefined)
                        : Effect.void,
                    ),
                  ),
            });
          }),
        ).pipe(Layer.provide(directoryLive));
        const providerLive = makeProviderServiceLive().pipe(
          Layer.provide(NodeServices.layer),
          Layer.provide(
            Layer.succeed(
              ProviderAdapterRegistry.ProviderAdapterRegistry,
              makeAdapterRegistryMock({ [provider]: fakeAdapter }),
            ),
          ),
          Layer.provide(directory),
          Layer.provide(observationsLayer),
          Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provide(ServerConfig.layerTest(dir, dir)),
          Layer.provide(AnalyticsService.layerTest),
          Layer.provide(
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        );
        const providerLayer = Layer.effect(
          ProviderService.ProviderService,
          Effect.gen(function* () {
            const service = yield* ProviderService.ProviderService;
            return ProviderService.ProviderService.of({
              ...service,
              streamEvents: Stream.scoped(
                Stream.fromPull(
                  Stream.toPull(service.streamEvents).pipe(
                    Effect.map((pull) =>
                      Effect.gen(function* () {
                        // The live bus subscribes on first pull, not when toPull is built.
                        const pulling = yield* pull.pipe(
                          Effect.forkChild({ startImmediately: true }),
                        );
                        yield* Deferred.succeed(ingestionSubscribed, undefined);
                        return yield* Fiber.join(pulling);
                      }),
                    ),
                  ),
                ),
              ),
            });
          }),
        ).pipe(Layer.provide(providerLive));
        const queryLive = OrchestrationProjectionSnapshotQueryLive.pipe(
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const ingestionQuery = Layer.effect(
          ProjectionSnapshotQuery,
          Effect.gen(function* () {
            const query = yield* ProjectionSnapshotQuery;
            return ProjectionSnapshotQuery.of({
              ...query,
              getThreadRuntimeContext: (id) => {
                if (!gate || id !== threadId) return query.getThreadRuntimeContext(id);
                const current = gate;
                gate = null;
                return Deferred.succeed(current.entered, undefined).pipe(
                  Effect.andThen(Deferred.await(current.release)),
                  Effect.andThen(query.getThreadRuntimeContext(id)),
                );
              },
            });
          }),
        ).pipe(Layer.provide(queryLive));
        const engineLayer = OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
          Layer.provide(OrchestrationEventStoreLive),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const layer = ProviderRuntimeIngestionLive.pipe(
          Layer.provideMerge(engineLayer),
          Layer.provideMerge(ingestionQuery),
          Layer.provideMerge(ThreadBackgroundLiveness.layer),
          Layer.provideMerge(ThreadPlanProgress.layer),
          Layer.provideMerge(providerLayer),
          Layer.provideMerge(observationsLayer),
          Layer.provideMerge(ServerSettings.ServerSettingsService.layerTest()),
          Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(persistence),
          Layer.provideMerge(restartContinuationsLayer),
          Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
          Layer.provideMerge(NodeServices.layer),
        );
        const liveLayerScope = yield* Scope.make("sequential");
        const ingestionScope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(layer, liveLayerScope);
        const live = Effect.provideContext(context);
        try {
          const engine = yield* live(Effect.service(OrchestrationEngineService));
          const ingestion = yield* live(Effect.service(ProviderRuntimeIngestionService));
          const providerService = yield* live(Effect.service(ProviderService.ProviderService));
          const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
            live(engine.dispatch(command));
          yield* dispatch({
            type: "project.create",
            commandId: CommandId.make("e11-project-create"),
            projectId,
            title: "E11",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "claude-opus" },
            createdAt: at,
          });
          yield* dispatch({
            type: "thread.create",
            commandId: CommandId.make("e11-thread-create"),
            projectId,
            threadId,
            title: "E11",
            modelSelection: { instanceId, model: "claude-opus" },
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: at,
          });
          yield* live(
            providerService.startSession(threadId, {
              provider,
              providerInstanceId: instanceId,
              threadId,
              cwd: dir,
              runtimeMode: "full-access",
            }),
          );
          yield* live(providerService.sendTurn({ threadId, input: "fixture" }));
          yield* live(ingestion.start().pipe(Scope.provide(ingestionScope)));
          yield* Deferred.await(ingestionSubscribed);

          // The first drain establishes that the old turn is projected as running.
          const baselineGate = yield* arm;
          yield* emit({
            ...base,
            type: "turn.started",
            eventId: EventId.make("e11-turn-started"),
            payload: {},
          });
          yield* Deferred.await(baselineGate.entered);
          yield* Deferred.succeed(baselineGate.release, undefined);
          yield* live(ingestion.drain);
          const liveQuery = yield* live(Effect.service(ProjectionSnapshotQuery));
          const baseline = yield* live(liveQuery.getCommandReadModel());
          expect(baseline.threads.find((x) => x.id === threadId)?.session?.activeTurnId).toBe(
            turnId,
          );

          itemGate = yield* arm;
          yield* emit(
            variant === "tool-blocked" || completedToolControl
              ? {
                  ...base,
                  type: "item.started",
                  eventId: EventId.make("e11-tool-started"),
                  itemId: RuntimeItemId.make("e11-tool"),
                  payload: {
                    itemType: "command_execution",
                    status: "inProgress",
                    title: "fixture command",
                    data: { toolCallId: "e11-call", command: "printf fixture" },
                  },
                }
              : variant === "approval-blocked" || variant === "approval-resolved"
                ? {
                    ...base,
                    type: "request.opened",
                    eventId: EventId.make("e11-approval-opened"),
                    requestId: RuntimeRequestId.make("e11-approval"),
                    payload: {
                      requestType: "command_execution_approval",
                      detail: "fixture command",
                    },
                  }
                : variant === "user-input-blocked" || variant === "user-input-resolved"
                  ? {
                      ...base,
                      type: "user-input.requested",
                      eventId: EventId.make("e11-user-input-requested"),
                      requestId: RuntimeRequestId.make("e11-user-input"),
                      payload: {
                        questions: [
                          {
                            id: "choice",
                            header: "Choice",
                            question: "Pick one",
                            options: [{ label: "A", description: "Option A" }],
                          },
                        ],
                      },
                    }
                  : {
                      ...base,
                      type: "item.completed",
                      eventId: EventId.make("e11-assistant-completed"),
                      itemId: RuntimeItemId.make("e11-assistant"),
                      payload: {
                        itemType: "assistant_message",
                        status: "completed",
                        detail: "E11 fixture answer",
                      },
                    },
          );
          yield* Deferred.await(itemGate.entered);
          if (variant === "drained" || completedToolControl || resolvedRequestControl) {
            yield* Deferred.succeed(itemGate.release, undefined);
            yield* live(ingestion.drain);
          }
          if (resolvedRequestControl) {
            const resolvedGate = yield* arm;
            yield* emit(
              variant === "approval-resolved"
                ? {
                    ...base,
                    createdAt: "2026-01-01T00:00:00.001Z",
                    type: "request.resolved",
                    eventId: EventId.make("e11-approval-resolved"),
                    requestId: RuntimeRequestId.make("e11-approval"),
                    payload: { requestType: "command_execution_approval", decision: "accept" },
                  }
                : {
                    ...base,
                    createdAt: "2026-01-01T00:00:00.001Z",
                    type: "user-input.resolved",
                    eventId: EventId.make("e11-user-input-resolved"),
                    requestId: RuntimeRequestId.make("e11-user-input"),
                    payload: { answers: { choice: "A" } },
                  },
            );
            yield* Deferred.await(resolvedGate.entered);
            yield* Deferred.succeed(resolvedGate.release, undefined);
            yield* live(ingestion.drain);
          }
          if (completedToolControl) {
            const completionGate = yield* arm;
            yield* emit({
              ...base,
              createdAt: "2026-01-01T00:00:00.001Z",
              type: "item.completed",
              eventId: EventId.make("e11-tool-completed"),
              itemId: RuntimeItemId.make("e11-tool"),
              payload: {
                itemType: "command_execution",
                status: "completed",
                title: "fixture command",
                data: { toolCallId: "e11-call", command: "printf fixture" },
              },
            });
            yield* Deferred.await(completionGate.entered);
            yield* Deferred.succeed(completionGate.release, undefined);
            yield* live(ingestion.drain);
          }
          if (variant === "null-turn-unmatched" || variant === "old-turn-unmatched") {
            const observations = yield* live(
              Effect.service(ProviderSafetyObservations.ProviderSafetyObservations),
            );
            yield* live(
              observations.record({
                threadId,
                turnId: variant === "null-turn-unmatched" ? null : TurnId.make("e11-previous-turn"),
                eventId: EventId.make("e11-unmatched-safety-event"),
                kind: "tool.started",
              }),
            );
          }
          if (variant === "assistant-blocked" || variant === "drained") {
            sessions.set(threadId, {
              ...sessions.get(threadId)!,
              resumeCursor: { resume: "native-session", resumeSessionAt: "B" },
              updatedAt: at,
            });
            const terminalGate = variant === "drained" ? yield* arm : null;
            yield* emit({
              ...base,
              type: "turn.completed",
              eventId: EventId.make("e11-terminal"),
              payload: { state: "completed" },
            });
            yield* Deferred.await(cursorB);
            if (terminalGate) {
              yield* Deferred.await(terminalGate.entered);
              yield* Deferred.succeed(terminalGate.release, undefined);
              yield* live(ingestion.drain);
            }
          }
          yield* live(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.unsafe(`VACUUM INTO '${snapshotPath}'`);
            }),
          );

          const snapshotPersistence = makeSqlitePersistenceLive(snapshotPath).pipe(
            Layer.provide(NodeServices.layer),
          );
          const snapshotDirectory = ProviderSessionDirectoryLive.pipe(
            Layer.provide(
              ProviderSessionRuntime.layer.pipe(Layer.provideMerge(snapshotPersistence)),
            ),
          );
          const snapshotObservations = ProviderSafetyObservations.layer.pipe(
            Layer.provide(snapshotPersistence),
          );
          const snapshotEngine = OrchestrationEngineLive.pipe(
            Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
            Layer.provide(ThreadBackgroundLiveness.layer),
            Layer.provide(ThreadPlanProgress.layer),
            Layer.provideMerge(OrchestrationProjectionPipelineLive),
            Layer.provide(OrchestrationEventStoreLive),
            Layer.provide(OrchestrationCommandReceiptRepositoryLive),
            Layer.provide(RepositoryIdentityResolver.layer),
            Layer.provideMerge(snapshotPersistence),
            Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
            Layer.provideMerge(NodeServices.layer),
          );
          const sent = yield* Deferred.make<void>();
          // Restart uses explicit fixture methods and never accesses the live database.
          const unexpected = () => Effect.die(new Error("Unexpected snapshot provider method"));
          const snapshotProvider = ProviderService.ProviderService.of({
            previewSubmissionRoute: unexpected,
            startSession: unexpected,
            sendTurn: () =>
              Deferred.succeed(sent, undefined).pipe(
                Effect.andThen(
                  expectsBlocked
                    ? Effect.die(new Error("Safety-uncertain turn must not auto-continue"))
                    : Effect.succeed({ threadId, turnId: TurnId.make("e11-recovery-turn") }),
                ),
              ),
            compactThread: unexpected,
            interruptTurn: unexpected,
            respondToRequest: unexpected,
            respondToUserInput: unexpected,
            stopSession: unexpected,
            listSessions: () => Effect.succeed([]),
            getCapabilities: () => Effect.succeed(fakeAdapter.capabilities),
            getInstanceInfo: unexpected,
            assertConversationRollbackSupported: unexpected,
            rollbackConversation: unexpected,
            uploadFeedback: unexpected,
            streamEvents: Stream.empty,
          });
          const snapshotMemorySendGateLayer = projectMemorySendGateLayer.pipe(
            Layer.provideMerge(projectMemorySendLedgerLayer),
            Layer.provideMerge(snapshotPersistence),
          );
          const snapshotLayer = Layer.mergeAll(
            snapshotEngine,
            snapshotDirectory,
            snapshotObservations,
            snapshotMemorySendGateLayer,
            Layer.succeed(ProviderService.ProviderService, snapshotProvider),
            ServerSettings.ServerSettingsService.layerTest({
              continueThreadsAfterServerUpdate: true,
            }),
            NodeServices.layer,
          ).pipe(Layer.provideMerge(restartContinuationsLayer));
          const snapshotLayerScope = yield* Scope.make("sequential");
          const recoveryScope = yield* Scope.make("sequential");
          const snapshotContext = yield* Layer.buildWithScope(snapshotLayer, snapshotLayerScope);
          const snapshot = Effect.provideContext(snapshotContext);
          let recoveryScopeClosed = false;
          try {
            const query = yield* snapshot(Effect.service(ProjectionSnapshotQuery));
            const directoryService = yield* snapshot(
              Effect.service(ProviderSessionDirectory.ProviderSessionDirectory),
            );
            const before = yield* snapshot(query.getThreadDetailById(threadId));
            const binding = yield* snapshot(directoryService.getBinding(threadId));
            const beforeThread = Option.getOrThrow(before);
            const beforeBinding = Option.getOrThrow(binding);
            expect(
              (beforeBinding.resumeCursor as { resumeSessionAt?: string }).resumeSessionAt,
            ).toBe(blockedSafety || completedToolControl || resolvedRequestControl ? "A" : "B");
            const beforeSummary = {
              session: beforeThread.session?.status,
              cursor: (beforeBinding.resumeCursor as { resumeSessionAt?: string }).resumeSessionAt,
              bindingStatus: beforeBinding.status,
              toolStarts: beforeThread.activities.filter((x) => x.kind === "tool.started").length,
              toolCompletions: beforeThread.activities.filter((x) => x.kind === "tool.completed")
                .length,
              approvalRequests: beforeThread.activities.filter(
                (x) => x.kind === "approval.requested",
              ).length,
              userInputRequests: beforeThread.activities.filter(
                (x) => x.kind === "user-input.requested",
              ).length,
              assistantText: beforeThread.messages
                .filter((x) => x.role === "assistant")
                .map((x) => x.text),
            };
            yield* snapshot(
              ServerRuntimeStartup.reconcileProviderSessions.pipe(Scope.provide(recoveryScope)),
            );
            const after = Option.getOrThrow(yield* snapshot(query.getThreadDetailById(threadId)));
            if (
              (variant === "assistant-blocked" ||
                variant === "tool-completed" ||
                variant === "old-turn-unmatched" ||
                resolvedRequestControl) &&
              after.session?.status === "starting"
            ) {
              yield* Deferred.await(sent);
            }
            const afterBinding = Option.getOrThrow(
              yield* snapshot(directoryService.getBinding(threadId)),
            );
            const afterPayload = afterBinding.runtimePayload as Record<string, unknown> | null;
            let secondReconcile: {
              session: string | undefined;
              bindingStatus: string | undefined;
              continuationSent: boolean;
            } | null = null;
            if (expectsBlocked) {
              yield* snapshot(
                ServerRuntimeStartup.reconcileProviderSessions.pipe(Scope.provide(recoveryScope)),
              );
              const secondThread = Option.getOrThrow(
                yield* snapshot(query.getThreadDetailById(threadId)),
              );
              const secondBinding = Option.getOrThrow(
                yield* snapshot(directoryService.getBinding(threadId)),
              );
              secondReconcile = {
                session: secondThread.session?.status,
                bindingStatus: secondBinding.status,
                continuationSent: yield* Deferred.isDone(sent),
              };
            }
            const result = {
              variant,
              before: beforeSummary,
              afterSession: after.session?.status,
              afterLastError: after.session?.lastError,
              oldTurnState: after.latestTurn?.state,
              afterBindingStatus: afterBinding.status,
              markersCleared:
                afterPayload?.continueAfterServerUpdate == null &&
                afterPayload?.continueAfterServerUpdatePrepared == null,
              continuationSent: yield* Deferred.isDone(sent),
              secondReconcile,
            };
            if (expectsBlocked) {
              expect(result.before.toolStarts).toBe(variant === "null-turn-unmatched" ? 1 : 0);
              expect(result.before.toolCompletions).toBe(variant === "null-turn-unmatched" ? 1 : 0);
              expect(result.before.approvalRequests).toBe(0);
              expect(result.before.userInputRequests).toBe(0);
              expect(result.afterSession).toBe("error");
              expect(result.afterLastError).toContain("result is unknown");
              expect(result.oldTurnState).toBe("error");
              expect(result.afterBindingStatus).toBe("stopped");
              expect(result.markersCleared).toBe(true);
              expect(result.continuationSent).toBe(false);
              expect(result.secondReconcile).toEqual({
                session: "error",
                bindingStatus: "stopped",
                continuationSent: false,
              });
              yield* Scope.close(recoveryScope, Exit.void);
              recoveryScopeClosed = true;
              expect(yield* Deferred.isDone(sent)).toBe(false);
            } else if (variant === "assistant-blocked") {
              expect(result.before.assistantText).toEqual([]);
              expect(result.continuationSent).toBe(true);
              expect(result.oldTurnState).toBe("interrupted");
            } else if (completedToolControl) {
              expect(result.before.toolStarts).toBe(1);
              expect(result.before.toolCompletions).toBe(1);
              expect(result.continuationSent).toBe(true);
              expect(result.oldTurnState).toBe("interrupted");
            } else if (resolvedRequestControl) {
              expect(result.before.approvalRequests).toBe(variant === "approval-resolved" ? 1 : 0);
              expect(result.before.userInputRequests).toBe(
                variant === "user-input-resolved" ? 1 : 0,
              );
              expect(result.continuationSent).toBe(true);
              expect(result.oldTurnState).toBe("interrupted");
            } else {
              expect(result.before.assistantText).toContain("E11 fixture answer");
              expect(result.continuationSent).toBe(false);
            }
          } finally {
            if (!recoveryScopeClosed) {
              yield* Scope.close(recoveryScope, Exit.void);
            }
            yield* Scope.close(snapshotLayerScope, Exit.void);
          }
        } finally {
          for (const pending of gates) {
            yield* Deferred.succeed(pending.release, undefined);
          }
          yield* Scope.close(ingestionScope, Exit.void);
          yield* Scope.close(liveLayerScope, Exit.void);
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
    );
  }
});
