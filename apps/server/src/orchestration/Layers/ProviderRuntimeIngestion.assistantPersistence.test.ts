// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { applyThreadDetailEvent } from "../../../../../packages/client-runtime/src/state/threadReducer.ts";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../../persistence/Services/ProjectionTurns.ts";
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
import * as ProviderService from "../../provider/Services/ProviderService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import * as RestartContinuations from "../../restartContinuations.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";

const projectId = ProjectId.make("e14-project");
const threadId = ThreadId.make("e14-thread");
const turnId = TurnId.make("e14-turn");
const itemId = RuntimeItemId.make("e14-assistant-item");
const messageId = MessageId.make(`assistant:${itemId}`);
const at = "2026-01-01T00:00:00.000Z";
const chunkA = "E14 persisted prefix. ";
const chunkB = "E14 missing suffix nonce-47c2.";
const fullText = `${chunkA}${chunkB}`;
const reasoningText = "E15 reasoning write failure nonce-29a1.";
const staleText = "E15 stale old-turn suffix nonce-3ea6.";
const assistantWriteFault =
  "Part of the assistant's response could not be saved, so the answer shown may be incomplete.";
describe("assistant persistence failures settle the affected turn honestly", () => {
  for (const scenario of [
    { name: "token-control", mode: "token", fail: false, itemCompletion: true },
    { name: "token-append-fault", mode: "token", fail: true, itemCompletion: true },
    {
      name: "terminal-error-write-retries-on-duplicate",
      mode: "token",
      fail: true,
      itemCompletion: true,
      terminalErrorFail: true,
    },
    {
      name: "prepass-complete-failure-retries-marker-only",
      mode: "token",
      fail: false,
      itemCompletion: false,
      completeFault: true,
    },
    {
      name: "null-active-starting-assistant-fault",
      mode: "token",
      fail: true,
      itemCompletion: true,
      nullActiveAtFailure: true,
    },
    {
      name: "null-turn-assistant-fault-keeps-existing-lifecycle",
      mode: "token",
      fail: true,
      itemCompletion: true,
      nullTurnDelta: true,
    },
    {
      name: "reasoning-write-fault-keeps-existing-lifecycle",
      mode: "token",
      fail: false,
      itemCompletion: true,
      reasoningFault: true,
    },
    {
      name: "token-fault-then-error-write-fault",
      mode: "token",
      fail: true,
      itemCompletion: true,
      errorWriteFail: true,
    },
    { name: "turn-control", mode: "turn", fail: false, itemCompletion: true },
    { name: "turn-append-fault", mode: "turn", fail: true, itemCompletion: true },
    { name: "terminal-flush-control", mode: "turn", fail: false, itemCompletion: false },
    { name: "terminal-flush-fault", mode: "turn", fail: true, itemCompletion: false },
    {
      name: "pre-ready-terminal-flush-fault",
      mode: "turn",
      fail: true,
      itemCompletion: false,
      earlyReady: true,
    },
    {
      name: "pre-ready-terminal-flush-control",
      mode: "turn",
      fail: false,
      itemCompletion: false,
      earlyReady: true,
    },
    {
      name: "codex-early-ready-control",
      mode: "turn",
      fail: false,
      itemCompletion: false,
      earlyReady: true,
      codex: true,
    },
    {
      name: "codex-append-fault-keeps-existing-lifecycle",
      mode: "token",
      fail: true,
      itemCompletion: true,
      codex: true,
    },
    {
      name: "post-fault-untargeted-events",
      mode: "token",
      fail: true,
      itemCompletion: true,
      afterFault: "untargeted",
    },
    {
      name: "post-fault-pending-next-turn",
      mode: "token",
      fail: true,
      itemCompletion: true,
      afterFault: "pending-next",
    },
    {
      name: "post-fault-session-exit",
      mode: "token",
      fail: true,
      itemCompletion: true,
      afterFault: "exit",
    },
    {
      name: "stale-old-delta-while-next-turn-running",
      mode: "token",
      fail: true,
      itemCompletion: true,
      afterFault: "stale-running",
    },
    {
      name: "stale-old-delta-after-next-turn-completed",
      mode: "token",
      fail: true,
      itemCompletion: true,
      afterFault: "stale-completed",
    },
    {
      name: "pending-steering-message-during-fault",
      mode: "token",
      fail: true,
      itemCompletion: true,
      steering: true,
    },
    {
      name: "first-terminal-after-reactor-starting",
      mode: "token",
      fail: true,
      itemCompletion: false,
      firstTerminalAfterStarting: true,
    },
    {
      name: "first-abort-after-reactor-starting",
      mode: "token",
      fail: true,
      itemCompletion: false,
      firstTerminalAfterStarting: true,
      firstAbort: true,
    },
    {
      name: "pending-new-turn-before-first-old-terminal",
      mode: "token",
      fail: true,
      itemCompletion: true,
      pendingNBeforeTerminal: true,
    },
  ] as const) {
    it.live(scenario.name, () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), `e15-${scenario.name}-`));
        const provider = ProviderDriverKind.make("codex" in scenario ? "codex" : "claudeAgent");
        const instanceId = ProviderInstanceId.make("codex" in scenario ? "codex" : "claudeAgent");
        const appendedText = scenario.mode === "token" ? chunkB : fullText;
        const claudeFault =
          scenario.fail && !("codex" in scenario) && !("nullTurnDelta" in scenario);
        const bus = yield* PubSub.unbounded<ProviderRuntimeEvent>({ replay: 10 });
        const ingestionSubscribed = yield* Deferred.make<void>();
        const faultReceipt = yield* Deferred.make<{
          eventType: string;
          messageId: string;
          nonce: string;
          attemptNumber: number;
        }>();
        const errorWriteFaultReceipt = yield* Deferred.make<void>();
        const reasoningFaultReceipt = yield* Deferred.make<void>();
        const staleFaultReceipt = yield* Deferred.make<void>();
        const terminalErrorFaultReceipt = yield* Deferred.make<void>();
        const completionFaultReceipt = yield* Deferred.make<void>();
        const sessions = new Map<ThreadId, ProviderSession>();
        const warnings: Array<{
          text: string;
          source: string | null;
          eventId: string | null;
          eventType: string | null;
          cause: string | null;
        }> = [];
        let matchingAppendAttempts = 0;
        let injectedFailures = 0;
        let errorWriteAttempts = 0;
        let reasoningWriteAttempts = 0;
        let staleWriteAttempts = 0;
        let terminalErrorWriteAttempts = 0;
        let completionWriteAttempts = 0;
        type Gate = { entered: Deferred.Deferred<void>; release: Deferred.Deferred<void> };
        let gate: Gate | null = null;
        const gates: Gate[] = [];
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
        const persistence = makeSqlitePersistenceLive(NodePath.join(dir, "live.sqlite"));
        const observationsLayer = ProviderSafetyObservations.layer.pipe(Layer.provide(persistence));
        const directory = ProviderSessionDirectoryLive.pipe(
          Layer.provide(ProviderSessionRuntime.layer.pipe(Layer.provide(persistence))),
        );
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
          Layer.provide(
            ServerSettings.ServerSettingsService.layerTest({
              responseStreamingMode: scenario.mode,
            }),
          ),
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
                        // In this live stream the PubSub subscription is acquired on first pull.
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
        const eventStore = Layer.effect(
          OrchestrationEventStore,
          Effect.gen(function* () {
            const store = yield* OrchestrationEventStore;
            return OrchestrationEventStore.of({
              ...store,
              append: (event) =>
                Effect.suspend(() => {
                  if (
                    "errorWriteFail" in scenario &&
                    event.type === "thread.session-set" &&
                    Predicate.isObject(event.payload) &&
                    "session" in event.payload &&
                    Predicate.isObject(event.payload.session) &&
                    "status" in event.payload.session &&
                    event.payload.session.status === "error"
                  ) {
                    errorWriteAttempts += 1;
                    if (errorWriteAttempts === 1) {
                      return Deferred.succeed(errorWriteFaultReceipt, undefined).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new PersistenceSqlError({
                              operation: "E15.OrchestrationEventStore.append.errorSession",
                              detail: "injected one-shot error status append failure",
                            }),
                          ),
                        ),
                      );
                    }
                  }
                  if (
                    "terminalErrorFail" in scenario &&
                    event.type === "thread.session-set" &&
                    Predicate.isObject(event.payload) &&
                    "session" in event.payload &&
                    Predicate.isObject(event.payload.session) &&
                    "status" in event.payload.session &&
                    event.payload.session.status === "error" &&
                    String(event.commandId).includes(":thread-session-set:")
                  ) {
                    terminalErrorWriteAttempts += 1;
                    if (terminalErrorWriteAttempts === 1) {
                      return Deferred.succeed(terminalErrorFaultReceipt, undefined).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new PersistenceSqlError({
                              operation: "E15.OrchestrationEventStore.append.terminalError",
                              detail: "injected first terminal error write failure",
                            }),
                          ),
                        ),
                      );
                    }
                  }
                  if (
                    "completeFault" in scenario &&
                    event.type === "thread.message-sent" &&
                    Predicate.isObject(event.payload) &&
                    "role" in event.payload &&
                    "messageId" in event.payload &&
                    "text" in event.payload &&
                    event.payload.role === "assistant" &&
                    event.payload.messageId === messageId &&
                    event.payload.text === ""
                  ) {
                    completionWriteAttempts += 1;
                    if (completionWriteAttempts === 1) {
                      return Deferred.succeed(completionFaultReceipt, undefined).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new PersistenceSqlError({
                              operation: "E15.OrchestrationEventStore.append.complete",
                              detail: "injected pre-pass complete marker failure",
                            }),
                          ),
                        ),
                      );
                    }
                  }
                  if (
                    "reasoningFault" in scenario &&
                    event.type === "thread.message-sent" &&
                    Predicate.isObject(event.payload) &&
                    "role" in event.payload &&
                    "text" in event.payload &&
                    event.payload.role === "reasoning" &&
                    event.payload.text === reasoningText
                  ) {
                    reasoningWriteAttempts += 1;
                    if (reasoningWriteAttempts === 1) {
                      return Deferred.succeed(reasoningFaultReceipt, undefined).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new PersistenceSqlError({
                              operation: "E15.OrchestrationEventStore.append.reasoning",
                              detail: "injected one-shot reasoning append failure",
                            }),
                          ),
                        ),
                      );
                    }
                  }
                  if (
                    "afterFault" in scenario &&
                    (scenario.afterFault === "stale-running" ||
                      scenario.afterFault === "stale-completed" ||
                      scenario.afterFault === "pending-next") &&
                    event.type === "thread.message-sent" &&
                    Predicate.isObject(event.payload) &&
                    "role" in event.payload &&
                    "text" in event.payload &&
                    event.payload.role === "assistant" &&
                    event.payload.text === staleText
                  ) {
                    staleWriteAttempts += 1;
                    if (staleWriteAttempts === 1) {
                      return Deferred.succeed(staleFaultReceipt, undefined).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new PersistenceSqlError({
                              operation: "E15.OrchestrationEventStore.append.stale",
                              detail: "injected stale old-turn append failure",
                            }),
                          ),
                        ),
                      );
                    }
                  }
                  if (
                    event.type === "thread.message-sent" &&
                    Predicate.isObject(event.payload) &&
                    "role" in event.payload &&
                    "messageId" in event.payload &&
                    "text" in event.payload &&
                    event.payload.role === "assistant" &&
                    event.payload.messageId === messageId &&
                    event.payload.text === appendedText
                  ) {
                    matchingAppendAttempts += 1;
                    if (scenario.fail && injectedFailures === 0) {
                      injectedFailures += 1;
                      return Deferred.succeed(faultReceipt, {
                        eventType: event.type,
                        messageId,
                        nonce: appendedText,
                        attemptNumber: matchingAppendAttempts,
                      }).pipe(
                        Effect.andThen(
                          Effect.fail(
                            new PersistenceSqlError({
                              operation: "E14.OrchestrationEventStore.append",
                              detail: "injected one-shot assistant append failure",
                            }),
                          ),
                        ),
                      );
                    }
                  }
                  return store.append(event);
                }),
            });
          }),
        ).pipe(Layer.provide(OrchestrationEventStoreLive.pipe(Layer.provide(persistence))));
        const engineLayer = OrchestrationEngineLive.pipe(
          Layer.provide(OrchestrationProjectionSnapshotQueryLive),
          Layer.provide(OrchestrationProjectionPipelineLive),
          Layer.provide(eventStore),
          Layer.provide(OrchestrationCommandReceiptRepositoryLive),
          Layer.provide(RepositoryIdentityResolver.layer),
          Layer.provide(persistence),
        );
        const capture = Logger.make(({ logLevel, message }) => {
          if (logLevel !== "Warn") return;
          const parts = Array.isArray(message) ? message : [message];
          const fields = parts.find(Predicate.isObject);
          warnings.push({
            text: parts.filter((part) => typeof part === "string").join(" "),
            source: fields && typeof fields.source === "string" ? fields.source : null,
            eventId: fields && typeof fields.eventId === "string" ? fields.eventId : null,
            eventType: fields && typeof fields.eventType === "string" ? fields.eventType : null,
            cause: fields && typeof fields.cause === "string" ? fields.cause : null,
          });
        });
        const layer = ProviderRuntimeIngestionLive.pipe(
          Layer.provideMerge(engineLayer),
          Layer.provideMerge(ingestionQuery),
          Layer.provideMerge(ThreadBackgroundLiveness.layer),
          Layer.provideMerge(ThreadPlanProgress.layer),
          Layer.provideMerge(ProjectionTurnRepositoryLive.pipe(Layer.provide(persistence))),
          Layer.provideMerge(providerLayer),
          Layer.provideMerge(observationsLayer),
          Layer.provideMerge(
            ServerSettings.ServerSettingsService.layerTest({
              responseStreamingMode: scenario.mode,
            }),
          ),
          Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
          Layer.provideMerge(VcsProcess.layer),
          // Provided after every layer that reads the database or continuation tokens, so the
          // provider, checkpoint store, and engine all share one SQLite client and one token map.
          Layer.provideMerge(persistence),
          Layer.provideMerge(RestartContinuations.layer),
          Layer.provideMerge(ServerConfig.layerTest(dir, dir)),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(Logger.layer([capture], { mergeWithExisting: false })),
        );
        const layerScope = yield* Scope.make("sequential");
        const ingestionScope = yield* Scope.make("sequential");
        const context = yield* Layer.buildWithScope(layer, layerScope);
        const live = Effect.provideContext(context);
        try {
          const engine = yield* live(Effect.service(OrchestrationEngineService));
          const ingestion = yield* live(Effect.service(ProviderRuntimeIngestionService));
          const service = yield* live(Effect.service(ProviderService.ProviderService));
          const query = yield* live(Effect.service(ProjectionSnapshotQuery));
          const turns = yield* live(Effect.service(ProjectionTurnRepository));
          const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
            live(engine.dispatch(command));
          yield* dispatch({
            type: "project.create",
            commandId: CommandId.make("e14-project-create"),
            projectId,
            title: "E14",
            workspaceRoot: dir,
            defaultModelSelection: { instanceId, model: "claude-opus" },
            createdAt: at,
          });
          yield* dispatch({
            type: "thread.create",
            commandId: CommandId.make("e14-thread-create"),
            projectId,
            threadId,
            title: "E14",
            modelSelection: { instanceId, model: "claude-opus" },
            interactionMode: "default",
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: at,
          });
          const initialThread = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
          const initialSequence = yield* live(engine.latestSequence);
          yield* live(
            service.startSession(threadId, {
              provider,
              providerInstanceId: instanceId,
              threadId,
              cwd: dir,
              runtimeMode: "full-access",
            }),
          );
          yield* live(service.sendTurn({ threadId, input: "fixture" }));
          yield* live(ingestion.start().pipe(Scope.provide(ingestionScope)));
          yield* Deferred.await(ingestionSubscribed);
          const emitAndDrain = (event: ProviderRuntimeEvent) =>
            Effect.gen(function* () {
              const current = yield* arm;
              yield* emit(event);
              yield* Deferred.await(current.entered);
              yield* Deferred.succeed(current.release, undefined);
              yield* live(ingestion.drain);
            });
          const readThreadEvents = live(Stream.runCollect(engine.readEvents(0))).pipe(
            Effect.map((events) =>
              Array.from(events).filter(
                (event) => event.aggregateKind === "thread" && event.aggregateId === threadId,
              ),
            ),
          );
          const messageEventRows = (events: ReadonlyArray<OrchestrationEvent>) =>
            events.flatMap((event) => {
              const payload = event.payload;
              return event.type === "thread.message-sent" &&
                Predicate.isObject(payload) &&
                "role" in payload &&
                "messageId" in payload &&
                "text" in payload &&
                payload.role === "assistant" &&
                payload.messageId === messageId &&
                typeof payload.text === "string"
                ? [{ sequence: event.sequence, text: payload.text }]
                : [];
            });
          yield* emitAndDrain({
            ...base,
            type: "turn.started",
            eventId: EventId.make("e14-turn-started"),
            payload: {},
          });
          const delta = (
            eventId: EventId,
            createdAt: string,
            text: string,
            omitTurnId = false,
          ): ProviderRuntimeEvent => ({
            provider,
            threadId,
            ...(omitTurnId ? {} : { turnId }),
            type: "content.delta",
            eventId,
            createdAt,
            itemId,
            payload: { streamKind: "assistant_text", delta: text },
          });
          yield* emitAndDrain(
            delta(EventId.make("e14-delta-a"), "2026-01-01T00:00:00.001Z", chunkA),
          );
          const afterA = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
          const aEvents = yield* readThreadEvents;
          expect(afterA.messages.find((message) => message.id === messageId)?.text).toBe(
            scenario.mode === "token" ? chunkA : undefined,
          );
          expect(messageEventRows(aEvents).map((event) => event.text)).toEqual(
            scenario.mode === "token" ? [chunkA] : [],
          );
          if ("steering" in scenario) {
            yield* dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("e15-steering-message"),
              threadId,
              message: {
                messageId: MessageId.make("e15-steering-user-message"),
                role: "user",
                text: "steer while running",
                attachments: [],
              },
              interactionMode: "default",
              runtimeMode: "full-access",
              createdAt: at,
            });
            expect(
              Option.isSome(yield* live(turns.getPendingTurnStartByThreadId({ threadId }))),
            ).toBe(true);
          }
          if ("nullActiveAtFailure" in scenario) {
            yield* dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("e15-null-active-message"),
              threadId,
              message: {
                messageId: MessageId.make("e15-null-active-user-message"),
                role: "user",
                text: "steered message",
                attachments: [],
              },
              interactionMode: "default",
              runtimeMode: "full-access",
              createdAt: at,
            });
            yield* dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("e15-null-active-reactor-starting"),
              threadId,
              session: {
                threadId,
                status: "starting",
                providerName: provider,
                providerInstanceId: instanceId,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: at,
              },
              createdAt: at,
            });
          }
          yield* emitAndDrain(
            delta(
              EventId.make("e14-delta-b"),
              "2026-01-01T00:00:00.002Z",
              chunkB,
              "nullTurnDelta" in scenario,
            ),
          );
          const afterB = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
          expect(afterB.messages.find((message) => message.id === messageId)?.text).toBe(
            scenario.mode === "token" ? (scenario.fail ? chunkA : fullText) : undefined,
          );
          if (scenario.itemCompletion) {
            yield* emitAndDrain({
              ...base,
              type: "item.completed",
              eventId: EventId.make("e14-item-completed"),
              itemId,
              createdAt: "2026-01-01T00:00:00.003Z",
              payload: { itemType: "assistant_message", status: "completed", detail: fullText },
            });
          }
          if ("reasoningFault" in scenario) {
            yield* emitAndDrain({
              ...base,
              type: "content.delta",
              eventId: EventId.make("e15-reasoning-delta"),
              itemId: RuntimeItemId.make("e15-reasoning-item"),
              createdAt: "2026-01-01T00:00:00.003Z",
              payload: { streamKind: "reasoning_text", delta: reasoningText },
            });
          }
          if ("firstTerminalAfterStarting" in scenario) {
            expect(yield* Deferred.isDone(faultReceipt)).toBe(true);
            yield* dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("e15-steer-after-fault"),
              threadId,
              message: {
                messageId: MessageId.make("e15-steer-after-fault-message"),
                role: "user",
                text: "continue same Claude turn",
                attachments: [],
              },
              interactionMode: "default",
              runtimeMode: "full-access",
              createdAt: at,
            });
            const pendingBefore = Option.isSome(
              yield* live(turns.getPendingTurnStartByThreadId({ threadId })),
            );
            expect(pendingBefore).toBe(true);
            yield* dispatch({
              type: "thread.session.set",
              commandId: CommandId.make("e15-reactor-equivalent-starting"),
              threadId,
              session: {
                threadId,
                status: "starting",
                providerName: provider,
                providerInstanceId: instanceId,
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: at,
              },
              createdAt: at,
            });
            yield* emitAndDrain(
              delta(EventId.make("e15-steered-same-turn-delta"), at, "same-turn continuation"),
            );
            const eventCountBeforeTerminal = (yield* readThreadEvents).length;
            if ("firstAbort" in scenario) {
              yield* emitAndDrain({
                ...base,
                type: "turn.aborted",
                eventId: EventId.make("e15-first-old-abort-after-starting"),
                createdAt: at,
                payload: { reason: "fixture interruption" },
              });
            } else {
              yield* emitAndDrain({
                ...base,
                type: "turn.completed",
                eventId: EventId.make("e15-first-old-terminal-after-starting"),
                createdAt: at,
                payload: { state: "completed" },
              });
            }
            const after = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
            const pendingAfter = Option.isSome(
              yield* live(turns.getPendingTurnStartByThreadId({ threadId })),
            );
            const eventCountAfterTerminal = (yield* readThreadEvents).length;
            const oldTurn = Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId })));
            process.stdout.write(
              `e15 case=${scenario.name} pendingBefore=${pendingBefore} pendingAfter=${pendingAfter} ` +
                `statusAfterFirstTerminal=${after.session?.status} activeTurnId=${after.session?.activeTurnId} ` +
                `oldTurnState=${oldTurn.state} terminalWriteCount=${eventCountAfterTerminal - eventCountBeforeTerminal}\n`,
            );
            expect(oldTurn.state).toBe("error");
            expect(after.session?.status).toBe("firstAbort" in scenario ? "interrupted" : "error");
            expect(pendingAfter).toBe(false);
            expect(
              after.messages.some(
                (message) =>
                  message.role === "user" && message.text === "continue same Claude turn",
              ),
            ).toBe(true);
            return;
          }
          if ("pendingNBeforeTerminal" in scenario) {
            const nextTurnId = TurnId.make("e15-race-next-turn");
            const nextMessageId = MessageId.make("e15-race-next-user-message");
            yield* dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make("e15-race-next-message"),
              threadId,
              message: {
                messageId: nextMessageId,
                role: "user",
                text: "new native turn message",
                attachments: [],
              },
              interactionMode: "default",
              runtimeMode: "full-access",
              createdAt: at,
            });
            expect(
              Option.isSome(yield* live(turns.getPendingTurnStartByThreadId({ threadId }))),
            ).toBe(true);
            yield* emitAndDrain({
              ...base,
              type: "turn.completed",
              eventId: EventId.make("e15-old-terminal-before-next-start"),
              createdAt: at,
              payload: { state: "completed" },
            });
            expect(
              Option.isNone(yield* live(turns.getPendingTurnStartByThreadId({ threadId }))),
            ).toBe(true);
            const oldTurn = Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId })));
            expect(oldTurn.state).toBe("error");
            yield* emitAndDrain({
              ...base,
              turnId: nextTurnId,
              type: "turn.started",
              eventId: EventId.make("e15-race-next-turn-started"),
              createdAt: at,
              payload: {},
            });
            yield* emitAndDrain({
              ...base,
              turnId: nextTurnId,
              type: "turn.completed",
              eventId: EventId.make("e15-race-next-turn-completed"),
              createdAt: at,
              payload: { state: "completed" },
            });
            const nextTurn = Option.getOrThrow(
              yield* live(turns.getByTurnId({ threadId, turnId: nextTurnId })),
            );
            const afterRace = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
            expect(nextTurn.state).toBe("completed");
            expect(nextTurn.pendingMessageId).toBeNull();
            expect(afterRace.session?.status).toBe("ready");
            expect(afterRace.messages.find((message) => message.id === nextMessageId)?.text).toBe(
              "new native turn message",
            );
            expect(
              Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId }))).state,
            ).toBe("error");
            return;
          }
          let preTerminalState: string | undefined;
          if ("earlyReady" in scenario) {
            yield* emitAndDrain({
              provider,
              threadId,
              type: "session.state.changed",
              eventId: EventId.make("e14-session-ready-before-terminal"),
              createdAt: "2026-01-01T00:00:00.003Z",
              payload: { state: "ready" },
            });
            const beforeTerminal = Option.getOrThrow(
              yield* live(query.getThreadDetailById(threadId)),
            );
            preTerminalState = beforeTerminal.latestTurn?.state;
          }
          yield* emitAndDrain({
            ...base,
            type: "turn.completed",
            eventId: EventId.make("e14-turn-completed"),
            createdAt: "2026-01-01T00:00:00.004Z",
            payload: { state: "completed" },
          });
          const beforeHealth = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
          const eventsBeforeHealth = yield* readThreadEvents;
          expect(beforeHealth.messages.find((message) => message.id === messageId)?.streaming).toBe(
            scenario.fail && scenario.mode === "turn" ? undefined : false,
          );
          if (scenario.fail) {
            expect(yield* Deferred.isDone(faultReceipt)).toBe(true);
            expect(yield* Deferred.await(faultReceipt)).toEqual({
              eventType: "thread.message-sent",
              messageId,
              nonce: appendedText,
              attemptNumber: 1,
            });
          }
          if ("earlyReady" in scenario) {
            // A ready before the terminal never ends an active turn, for any provider: Codex also
            // emits ready mid-turn (for example after Windows sandbox setup).
            expect(preTerminalState).toBe("running");
          }
          yield* dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("e14-health-title"),
            threadId,
            title: "E14 engine healthy",
          });
          const final = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
          const events = yield* readThreadEvents;
          let client = initialThread;
          for (const event of events.filter((entry) => entry.sequence > initialSequence)) {
            const result = applyThreadDetailEvent(client, event);
            expect(result.kind).not.toBe("deleted");
            if (result.kind === "updated") client = result.thread;
          }
          const assistantText = final.messages.find((message) => message.id === messageId)?.text;
          const clientText = client.messages.find((message) => message.id === messageId)?.text;
          const hasPersistedTarget = messageEventRows(events).some(
            (event) => event.text === appendedText,
          );
          const warning = warnings.filter((entry) =>
            entry.text.includes("provider runtime ingestion failed to process event"),
          );
          const sessionWrites = eventsBeforeHealth.filter(
            (event) => event.type === "thread.session-set",
          );
          const readyWrites = sessionWrites.filter(
            (event) => event.payload.session.status === "ready",
          );
          const readyWrite = readyWrites[readyWrites.length - 1];
          const completedMessageWrite = messageEventRows(eventsBeforeHealth).find(
            (event) => event.text === "",
          );
          expect(final.title).toBe("E14 engine healthy");
          expect(events.some((event) => event.type === "thread.meta-updated")).toBe(true);
          if (claudeFault) {
            for (const thread of [beforeHealth, final, client]) {
              expect(thread.latestTurn?.state).toBe("error");
              expect(thread.session?.status).toBe("error");
              expect(thread.session?.lastError).toBe(assistantWriteFault);
              expect(thread.activities).toEqual([]);
            }
            expect(readyWrite).toBeUndefined();
          } else {
            for (const thread of [beforeHealth, final, client]) {
              expect(thread.latestTurn?.state).toBe("completed");
              expect(thread.session?.status).toBe("ready");
              expect(thread.session?.lastError).toBeNull();
              expect(thread.activities).toEqual([]);
            }
            expect(readyWrite).toBeDefined();
            if (!("codex" in scenario) && !("completeFault" in scenario)) {
              expect(completedMessageWrite?.sequence).toBeLessThan(readyWrite!.sequence);
            }
          }
          if (scenario.name === "token-append-fault" || "errorWriteFail" in scenario) {
            expect(afterB.latestTurn?.state).toBe(
              "errorWriteFail" in scenario ? "running" : "error",
            );
            expect(afterB.session?.status).toBe("errorWriteFail" in scenario ? "running" : "error");
          }
          expect(clientText).toBe(assistantText);
          expect(matchingAppendAttempts).toBe(1);
          expect(injectedFailures).toBe(scenario.fail ? 1 : 0);
          expect(assistantText).toBe(
            scenario.fail ? (scenario.mode === "token" ? chunkA : undefined) : fullText,
          );
          expect(hasPersistedTarget).toBe(!scenario.fail);
          expect(messageEventRows(eventsBeforeHealth).map((event) => event.text)).toEqual(
            scenario.mode === "token"
              ? scenario.fail
                ? [chunkA, ""]
                : [chunkA, chunkB, ""]
              : scenario.fail
                ? []
                : [fullText, ""],
          );
          expect(warning.length).toBe("terminalErrorFail" in scenario ? 2 : scenario.fail ? 1 : 0);
          if ("errorWriteFail" in scenario) {
            expect(yield* Deferred.isDone(errorWriteFaultReceipt)).toBe(true);
            expect(errorWriteAttempts).toBe(2);
          }
          if ("reasoningFault" in scenario) {
            expect(yield* Deferred.isDone(reasoningFaultReceipt)).toBe(true);
            expect(reasoningWriteAttempts).toBe(1);
          }
          if ("completeFault" in scenario) {
            expect(yield* Deferred.isDone(completionFaultReceipt)).toBe(true);
            expect(completionWriteAttempts).toBe(2);
            expect(
              messageEventRows(eventsBeforeHealth)
                .filter((event) => event.text !== "")
                .map((event) => event.text),
            ).toEqual([chunkA, chunkB]);
          }
          if ("terminalErrorFail" in scenario) {
            expect(yield* Deferred.isDone(terminalErrorFaultReceipt)).toBe(true);
            expect(terminalErrorWriteAttempts).toBe(1);
            yield* emitAndDrain({
              ...base,
              type: "turn.completed",
              eventId: EventId.make("e15-duplicate-terminal-after-write-failure"),
              createdAt: at,
              payload: { state: "completed" },
            });
            const afterRetry = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
            expect(terminalErrorWriteAttempts).toBe(2);
            expect(afterRetry.session?.status).toBe("error");
            expect(afterRetry.session?.activeTurnId).toBeNull();
            expect(
              Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId }))).state,
            ).toBe("error");
          }
          if ("steering" in scenario) {
            // The SDK may already have accepted same-ID steering; this row alone is not delivery proof.
            process.stdout.write(
              `e15 case=${scenario.name} pendingAfterFaultedTerminal=${Option.isSome(
                yield* live(turns.getPendingTurnStartByThreadId({ threadId })),
              )} sessionStatus=${final.session?.status} activeTurnId=${final.session?.activeTurnId}\n`,
            );
          }
          if ("afterFault" in scenario) {
            const oldTurn = Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId })));
            expect(oldTurn.state).toBe("error");
            if (scenario.afterFault === "untargeted") {
              const count = events.length;
              yield* emitAndDrain({
                provider,
                threadId,
                type: "session.state.changed",
                eventId: EventId.make("e15-late-ready"),
                createdAt: at,
                payload: { state: "ready" },
              });
              yield* emitAndDrain({
                provider,
                threadId,
                type: "session.state.changed",
                eventId: EventId.make("e15-late-running"),
                createdAt: at,
                payload: { state: "running" },
              });
              yield* emitAndDrain({
                provider,
                threadId,
                type: "session.started",
                eventId: EventId.make("e15-late-session-started"),
                createdAt: at,
                payload: {},
              });
              const later = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
              expect((yield* readThreadEvents).length).toBe(count);
              expect(later.session?.status).toBe("error");
              expect(later.session?.lastError).toBe(assistantWriteFault);
              expect(
                (yield* live(turns.getByTurnId({ threadId, turnId }))).pipe(Option.getOrThrow)
                  .state,
              ).toBe("error");
            } else if (scenario.afterFault === "pending-next") {
              const nextTurnId = TurnId.make("e15-next-turn");
              yield* dispatch({
                type: "thread.turn.start",
                commandId: CommandId.make("e15-next-message"),
                threadId,
                message: {
                  messageId: MessageId.make("e15-next-user-message"),
                  role: "user",
                  text: "next message",
                  attachments: [],
                },
                interactionMode: "default",
                runtimeMode: "full-access",
                createdAt: at,
              });
              expect(
                Option.isSome(yield* live(turns.getPendingTurnStartByThreadId({ threadId }))),
              ).toBe(true);
              yield* dispatch({
                type: "thread.session.set",
                commandId: CommandId.make("e15-next-reactor-starting"),
                threadId,
                session: {
                  threadId,
                  status: "starting",
                  providerName: provider,
                  providerInstanceId: instanceId,
                  runtimeMode: "full-access",
                  activeTurnId: null,
                  lastError: null,
                  updatedAt: at,
                },
                createdAt: at,
              });
              yield* emitAndDrain(
                delta(EventId.make("e15-late-old-delta-after-terminal"), at, staleText),
              );
              expect(yield* Deferred.isDone(staleFaultReceipt)).toBe(true);
              expect(staleWriteAttempts).toBe(1);
              expect(
                Option.isSome(yield* live(turns.getPendingTurnStartByThreadId({ threadId }))),
              ).toBe(true);
              const afterLateDelta = Option.getOrThrow(
                yield* live(query.getThreadDetailById(threadId)),
              );
              expect(afterLateDelta.session?.status).toBe("starting");
              const beforeDuplicate = (yield* readThreadEvents).length;
              yield* emitAndDrain({
                ...base,
                type: "turn.completed",
                eventId: EventId.make("e15-duplicate-old-terminal"),
                createdAt: at,
                payload: { state: "completed" },
              });
              const duplicateWrites = (yield* readThreadEvents).slice(beforeDuplicate);
              expect(duplicateWrites.length).toBeLessThanOrEqual(1);
              for (const event of duplicateWrites) {
                expect(event).toMatchObject({
                  type: "thread.message-sent",
                  payload: { role: "assistant", messageId, text: "" },
                });
                if (Predicate.isObject(event.payload) && "turnId" in event.payload) {
                  expect(event.payload.turnId).toBe(turnId);
                }
              }
              expect(duplicateWrites.some((event) => event.type === "thread.session-set")).toBe(
                false,
              );
              expect(
                duplicateWrites.some(
                  (event) =>
                    Predicate.isObject(event.payload) &&
                    "turnId" in event.payload &&
                    event.payload.turnId === nextTurnId,
                ),
              ).toBe(false);
              expect(
                Option.isSome(yield* live(turns.getPendingTurnStartByThreadId({ threadId }))),
              ).toBe(true);
              const afterDuplicate = Option.getOrThrow(
                yield* live(query.getThreadDetailById(threadId)),
              );
              expect(afterDuplicate.session?.status).toBe("starting");
              expect(
                Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId }))).state,
              ).toBe("error");
              const oldAssistant = afterDuplicate.messages.find(
                (message) => message.id === messageId,
              );
              expect(oldAssistant?.text).toBe(chunkA);
              expect(oldAssistant?.streaming).toBe(false);
              expect(
                afterDuplicate.messages.some((message) => message.text.includes(staleText)),
              ).toBe(false);
              yield* emitAndDrain({
                provider,
                threadId,
                type: "session.state.changed",
                eventId: EventId.make("e15-ready-for-next-turn"),
                createdAt: at,
                payload: { state: "ready" },
              });
              const starting = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
              expect(starting.session?.status).toBe("starting");
              yield* emitAndDrain({
                ...base,
                turnId: nextTurnId,
                type: "turn.started",
                eventId: EventId.make("e15-next-turn-started"),
                createdAt: at,
                payload: {},
              });
              const running = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
              expect(running.session?.status).toBe("running");
              expect(running.session?.activeTurnId).toBe(nextTurnId);
              yield* emitAndDrain({
                ...base,
                turnId: nextTurnId,
                type: "turn.completed",
                eventId: EventId.make("e15-next-turn-completed"),
                createdAt: at,
                payload: { state: "completed" },
              });
              const settled = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
              expect(settled.session?.status).toBe("ready");
              expect(settled.latestTurn?.state).toBe("completed");
              expect(
                Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId }))).state,
              ).toBe("error");
            } else if (
              scenario.afterFault === "stale-running" ||
              scenario.afterFault === "stale-completed"
            ) {
              const nextTurnId = TurnId.make("e15-active-next-turn");
              yield* emitAndDrain({
                ...base,
                turnId: nextTurnId,
                type: "turn.started",
                eventId: EventId.make("e15-active-next-turn-started"),
                createdAt: at,
                payload: {},
              });
              if (scenario.afterFault === "stale-completed") {
                yield* emitAndDrain({
                  ...base,
                  turnId: nextTurnId,
                  type: "turn.completed",
                  eventId: EventId.make("e15-active-next-turn-completed"),
                  createdAt: at,
                  payload: { state: "completed" },
                });
              }
              const statusBeforeStale =
                scenario.afterFault === "stale-running" ? "running" : "ready";
              const beforeStale = Option.getOrThrow(
                yield* live(query.getThreadDetailById(threadId)),
              );
              expect(beforeStale.session?.status).toBe(statusBeforeStale);
              yield* emitAndDrain(delta(EventId.make("e15-stale-old-turn-delta"), at, staleText));
              expect(yield* Deferred.isDone(staleFaultReceipt)).toBe(true);
              expect(staleWriteAttempts).toBe(1);
              const afterStale = Option.getOrThrow(
                yield* live(query.getThreadDetailById(threadId)),
              );
              expect(afterStale.session?.status).toBe(statusBeforeStale);
              expect(afterStale.session?.activeTurnId).toBe(
                scenario.afterFault === "stale-running" ? nextTurnId : null,
              );
              expect(afterStale.session?.lastError).toBe(beforeStale.session?.lastError);
              expect(
                Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId }))).state,
              ).toBe("error");
              expect(
                Option.getOrThrow(yield* live(turns.getByTurnId({ threadId, turnId: nextTurnId })))
                  .state,
              ).toBe(scenario.afterFault === "stale-running" ? "running" : "completed");
            } else {
              yield* emitAndDrain({
                provider,
                threadId,
                type: "session.exited",
                eventId: EventId.make("e15-session-exited"),
                createdAt: at,
                payload: {},
              });
              const stopped = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
              expect(stopped.session?.status).toBe("stopped");
              yield* emitAndDrain({
                provider,
                threadId,
                type: "session.state.changed",
                eventId: EventId.make("e15-ready-after-exit"),
                createdAt: at,
                payload: { state: "ready" },
              });
              const reset = Option.getOrThrow(yield* live(query.getThreadDetailById(threadId)));
              expect(reset.session?.status).toBe("ready");
            }
          }
        } finally {
          for (const pending of gates) yield* Deferred.succeed(pending.release, undefined);
          yield* Scope.close(ingestionScope, Exit.void);
          yield* Scope.close(layerScope, Exit.void);
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }),
    );
  }
});
