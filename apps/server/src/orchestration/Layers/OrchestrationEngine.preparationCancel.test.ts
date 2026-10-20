// @effect-diagnostics nodeBuiltinImport:off
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import * as OrchestrationCommandReceipts from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  layer as restartContinuationsLayer,
  RestartContinuations,
} from "../../restartContinuations.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type OrchestrationEventStoreLayer = typeof OrchestrationEventStoreLive;

function makeOrchestrationLayer(
  eventStoreLayer: OrchestrationEventStoreLayer = OrchestrationEventStoreLive,
) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-preparation-cancel-test-",
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
    Layer.provide(eventStoreLayer),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

function decorateOrchestrationEventStoreLayer(
  decorate: (store: OrchestrationEventStoreShape) => OrchestrationEventStoreShape,
) {
  return Layer.effect(
    OrchestrationEventStore,
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore;
      return decorate(store);
    }),
  );
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

const PREPARATION_CANCEL_REJECT_DETAIL =
  "preparation cancellation rejected; the prepared thread state is no longer current";

describe("OrchestrationEngine preparationCancel", () => {
  const providerInstanceId = ProviderInstanceId.make("codex");

  const seedPreparationCancel = (
    engine: OrchestrationEngineShape,
    input: {
      readonly prefix: string;
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly createdAt: string;
      readonly control?: "stop" | "interrupt";
      readonly controlBeforeAnchor?: boolean;
      readonly anchorStatus?: "starting" | "running";
      readonly anchorProviderInstanceId?: ProviderInstanceId;
    },
  ) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`${input.prefix}-project`),
        projectId: input.projectId,
        title: "Preparation cancel",
        workspaceRoot: `/tmp/preparation-cancel-${input.prefix}`,
        createdAt: input.createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`${input.prefix}-thread`),
        threadId: input.threadId,
        projectId: input.projectId,
        title: "Preparation cancel",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt: input.createdAt,
      });
      const controlCommandId = CommandId.make(`${input.prefix}-control`);
      const dispatchControl = () =>
        input.control === "interrupt"
          ? engine.dispatch({
              type: "thread.turn.interrupt",
              commandId: controlCommandId,
              threadId: input.threadId,
              createdAt: input.createdAt,
            })
          : engine.dispatch({
              type: "thread.session.stop",
              commandId: controlCommandId,
              threadId: input.threadId,
              createdAt: input.createdAt,
            });
      let control: { sequence: number } | undefined;
      if (input.controlBeforeAnchor === true) control = yield* dispatchControl();
      const prepared = yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`${input.prefix}-prepare`),
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: input.anchorStatus ?? "starting",
          providerName: "codex",
          providerInstanceId: input.anchorProviderInstanceId ?? providerInstanceId,
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      control ??= yield* dispatchControl();
      // Each refused attempt needs a fresh command id: a rejected receipt makes
      // a replay surface PreviouslyRejected instead of the guard verdict.
      let settleCounter = 0;
      const settleCommand = (session: {
        readonly status: "stopped" | "error" | "ready";
        readonly lastError: string | null;
        readonly activeTurnId?: TurnId | null;
        readonly providerInstanceId?: ProviderInstanceId;
      }) => ({
        type: "thread.session.set" as const,
        commandId: CommandId.make(`${input.prefix}-settle-${settleCounter++}`),
        threadId: input.threadId,
        session: {
          threadId: input.threadId,
          status: session.status,
          providerName: "codex" as const,
          providerInstanceId: session.providerInstanceId ?? providerInstanceId,
          runtimeMode: "approval-required" as const,
          activeTurnId: session.activeTurnId ?? null,
          lastError: session.lastError,
          updatedAt: input.createdAt,
        },
        createdAt: input.createdAt,
      });
      return {
        threadId: input.threadId,
        prepared,
        control,
        preparationCancel: {
          preparationSequence: prepared.sequence,
          controlSequence: control.sequence,
        },
        settleCommand,
      };
    });

  const expectRejected = (
    engine: OrchestrationEngineShape,
    command: Parameters<OrchestrationEngineShape["dispatch"]>[0],
    preparationCancel: { preparationSequence: number; controlSequence: number },
  ) =>
    Effect.gen(function* () {
      const error = yield* engine.dispatch(command, { preparationCancel }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: PREPARATION_CANCEL_REJECT_DETAIL,
      });
    });

  effectIt.effect(
    "accepts a stopped terminal write anchored at its own starting set and stop control",
    () => {
      const createdAt = now();
      const threadId = ThreadId.make("prep-cancel-accept-stop");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const seeded = yield* seedPreparationCancel(engine, {
          prefix: "accept-stop",
          projectId: asProjectId("project-accept-stop"),
          threadId,
          createdAt,
          control: "stop",
        });

        const settle = seeded.settleCommand({ status: "stopped", lastError: null });
        const settled = yield* engine.dispatch(settle, {
          preparationCancel: seeded.preparationCancel,
        });
        expect(settled.sequence).toBeGreaterThan(seeded.control.sequence);
        const thread = yield* snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrThrow));
        expect(thread.session).toMatchObject({
          status: "stopped",
          activeTurnId: null,
          lastError: null,
        });
        const cleanupEvents = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk) =>
            Array.from(chunk).filter((event) => event.commandId === settle.commandId),
          ),
        );
        expect(cleanupEvents).toMatchObject([{ type: "thread.session-set" }]);
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect(
    "accepts an error terminal write whose interrupt control precedes the anchor",
    () => {
      const createdAt = now();
      const threadId = ThreadId.make("prep-cancel-accept-interrupt");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const seeded = yield* seedPreparationCancel(engine, {
          prefix: "accept-interrupt",
          projectId: asProjectId("project-accept-interrupt"),
          threadId,
          createdAt,
          control: "interrupt",
          // The control event is allowed to land before the "starting" write:
          // the scan covers the earlier of the two sequences.
          controlBeforeAnchor: true,
        });

        yield* engine.dispatch(
          seeded.settleCommand({
            status: "error",
            lastError:
              "The provider session could not be cleaned up after the stop. Continue in a new thread, or restart the server and check again.",
          }),
          { preparationCancel: seeded.preparationCancel },
        );
        const thread = yield* snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrThrow));
        expect(thread.session?.status).toBe("error");
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect(
    "rejects anchor and control citations that do not resolve to the claimed events",
    () => {
      const createdAt = now();
      const threadId = ThreadId.make("prep-cancel-citations");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const seeded = yield* seedPreparationCancel(engine, {
          prefix: "citations",
          projectId: asProjectId("project-citations"),
          threadId,
          createdAt,
          control: "stop",
        });

        // The anchor must land on the preparation session-set itself.
        yield* expectRejected(
          engine,
          seeded.settleCommand({ status: "stopped", lastError: null }),
          {
            preparationSequence: seeded.prepared.sequence - 1,
            controlSequence: seeded.preparationCancel.controlSequence,
          },
        );
        // The control citation must resolve to a committed event.
        yield* expectRejected(
          engine,
          seeded.settleCommand({ status: "stopped", lastError: null }),
          {
            preparationSequence: seeded.prepared.sequence,
            controlSequence: seeded.control.sequence + 50,
          },
        );
        // Swapped citations fail both exact-type lookups.
        yield* expectRejected(
          engine,
          seeded.settleCommand({ status: "stopped", lastError: null }),
          {
            preparationSequence: seeded.preparationCancel.controlSequence,
            controlSequence: seeded.preparationCancel.preparationSequence,
          },
        );
        // A session-stop-requested is not a preparation anchor.
        yield* expectRejected(
          engine,
          seeded.settleCommand({ status: "stopped", lastError: null }),
          {
            preparationSequence: seeded.control.sequence,
            controlSequence: seeded.control.sequence,
          },
        );
        // Non-positive sequences are never valid citations.
        yield* expectRejected(
          engine,
          seeded.settleCommand({ status: "stopped", lastError: null }),
          {
            preparationSequence: 0,
            controlSequence: seeded.control.sequence,
          },
        );

        const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(
          events.some(
            (event) => event.commandId !== null && event.commandId.startsWith("citations-settle-"),
          ),
        ).toBe(false);
        const thread = yield* snapshotQuery
          .getThreadDetailById(threadId)
          .pipe(Effect.map(Option.getOrThrow));
        // A refusal never falls back to an unconditional write.
        expect(thread.session?.status).toBe("starting");
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect("rejects a terminal write once the thread's history moved on", () => {
    const createdAt = now();
    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      // A newer session-set supersedes the cited preparation anchor.
      const superseded = yield* seedPreparationCancel(engine, {
        prefix: "superseded",
        projectId: asProjectId("project-superseded"),
        threadId: ThreadId.make("prep-cancel-superseded"),
        createdAt,
        control: "stop",
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("superseded-newer"),
        threadId: superseded.threadId,
        session: {
          threadId: superseded.threadId,
          status: "running",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-superseded"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
      yield* expectRejected(
        engine,
        superseded.settleCommand({ status: "stopped", lastError: null }),
        superseded.preparationCancel,
      );

      // A turn start after the control event means a newer owner claimed the
      // thread; the canceled preparation must not write over it.
      const reengaged = yield* seedPreparationCancel(engine, {
        prefix: "reengaged",
        projectId: asProjectId("project-reengaged"),
        threadId: ThreadId.make("prep-cancel-reengaged"),
        createdAt,
        control: "interrupt",
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("reengaged-turn"),
        threadId: reengaged.threadId,
        message: {
          messageId: MessageId.make("message-reengaged"),
          role: "user",
          text: "newer owner",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt,
      });
      yield* expectRejected(
        engine,
        reengaged.settleCommand({ status: "stopped", lastError: null }),
        reengaged.preparationCancel,
      );

      // A deleted thread leaves nothing to clean up.
      const deleted = yield* seedPreparationCancel(engine, {
        prefix: "deleted",
        projectId: asProjectId("project-deleted"),
        threadId: ThreadId.make("prep-cancel-deleted"),
        createdAt,
        control: "stop",
      });
      yield* engine.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("deleted-delete"),
        threadId: deleted.threadId,
      });
      yield* expectRejected(
        engine,
        deleted.settleCommand({ status: "stopped", lastError: null }),
        deleted.preparationCancel,
      );

      // None of the refused commands wrote an event; the threads keep the
      // state the newer owner left behind.
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      expect(
        events.some((event) => event.commandId !== null && /-settle-\d+$/.test(event.commandId)),
      ).toBe(false);
      const supersededThread = yield* snapshotQuery
        .getThreadDetailById(superseded.threadId)
        .pipe(Effect.map(Option.getOrThrow));
      expect(supersededThread.session?.status).toBe("running");
      const reengagedThread = yield* snapshotQuery
        .getThreadDetailById(reengaged.threadId)
        .pipe(Effect.map(Option.getOrThrow));
      expect(reengagedThread.session?.status).toBe("starting");
    }).pipe(Effect.provide(makeOrchestrationLayer()));
  });

  effectIt.effect(
    "rejects terminal writes whose identity or status does not match the anchor",
    () => {
      const createdAt = now();
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;

        const mismatch = yield* seedPreparationCancel(engine, {
          prefix: "identity",
          projectId: asProjectId("project-identity"),
          threadId: ThreadId.make("prep-cancel-identity"),
          createdAt,
          control: "stop",
        });
        // The terminal session must carry the anchor's identity forward.
        yield* expectRejected(
          engine,
          mismatch.settleCommand({
            status: "stopped",
            lastError: null,
            providerInstanceId: ProviderInstanceId.make("cursor"),
          }),
          mismatch.preparationCancel,
        );
        // Only terminal statuses may settle a canceled preparation.
        yield* expectRejected(
          engine,
          mismatch.settleCommand({ status: "ready", lastError: null }),
          mismatch.preparationCancel,
        );
        // A bound turn is never a canceled preparation's terminal write.
        yield* expectRejected(
          engine,
          mismatch.settleCommand({
            status: "stopped",
            lastError: null,
            activeTurnId: asTurnId("turn-bound"),
          }),
          mismatch.preparationCancel,
        );

        // An anchor that is not a "starting" session-set is not a canceled
        // preparation, even with a matching control event.
        const runningAnchor = yield* seedPreparationCancel(engine, {
          prefix: "running-anchor",
          projectId: asProjectId("project-running-anchor"),
          threadId: ThreadId.make("prep-cancel-running-anchor"),
          createdAt,
          control: "stop",
          anchorStatus: "running",
        });
        yield* expectRejected(
          engine,
          runningAnchor.settleCommand({ status: "stopped", lastError: null }),
          runningAnchor.preparationCancel,
        );

        const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(
          events.some((event) => event.commandId !== null && /-settle-\d+$/.test(event.commandId)),
        ).toBe(false);
      }).pipe(Effect.provide(makeOrchestrationLayer()));
    },
  );

  effectIt.effect("rejects a preparation cancel combined with a continuation settlement", () => {
    const createdAt = now();
    const threadId = ThreadId.make("prep-cancel-mixed");
    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const continuations = yield* RestartContinuations;
      // The interrupt control lands before the anchor so the settlement's own
      // scan sees no superseding control event and passes; the
      // preparationCancel block must still refuse the mixed dispatch.
      const seeded = yield* seedPreparationCancel(engine, {
        prefix: "mixed",
        projectId: asProjectId("project-mixed"),
        threadId,
        createdAt,
        control: "interrupt",
        controlBeforeAnchor: true,
      });
      const token = continuations.reserve(threadId, providerInstanceId);
      const settle = seeded.settleCommand({ status: "error", lastError: "cleanup" });
      continuations.record(token, { kind: "held", commandId: settle.commandId });
      const error = yield* engine
        .dispatch(settle, {
          continuationSettlement: {
            token,
            preparationSequence: seeded.prepared.sequence,
            preparationCommandId: CommandId.make("mixed-prepare"),
          },
          preparationCancel: seeded.preparationCancel,
        })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: PREPARATION_CANCEL_REJECT_DETAIL,
      });
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      expect(events.some((event) => event.commandId === settle.commandId)).toBe(false);
    }).pipe(Effect.provide(makeOrchestrationLayer()));
  });

  effectIt.effect("treats a failed anchor scan as retryable unavailability", () => {
    const failAggregateReads = { current: false };
    const wrappedStore = decorateOrchestrationEventStoreLayer((store) => ({
      ...store,
      readAggregateRange: (input) => {
        if (failAggregateReads.current) {
          return Stream.fail(
            new PersistenceSqlError({
              operation: "OrchestrationEventStore.readAggregateRange:query",
              detail: "simulated preparation-cancel scan failure",
            }),
          );
        }
        return store.readAggregateRange(input);
      },
    })).pipe(Layer.provide(OrchestrationEventStoreLive));

    const createdAt = now();
    const threadId = ThreadId.make("prep-cancel-transient");
    return Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
      const seeded = yield* seedPreparationCancel(engine, {
        prefix: "transient",
        projectId: asProjectId("project-transient"),
        threadId,
        createdAt,
        control: "stop",
      });
      const command = seeded.settleCommand({ status: "stopped", lastError: null });

      failAggregateReads.current = true;
      const transientError = yield* engine
        .dispatch(command, { preparationCancel: seeded.preparationCancel })
        .pipe(Effect.flip);
      expect(transientError._tag).toBe("OrchestrationCommandStateUnavailableError");
      // Unclear state writes no receipt, so the same command id can retry.
      expect(Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId }))).toBe(
        true,
      );

      failAggregateReads.current = false;
      const settled = yield* engine.dispatch(command, {
        preparationCancel: seeded.preparationCancel,
      });
      expect(settled.sequence).toBeGreaterThan(seeded.control.sequence);
      const thread = yield* ProjectionSnapshotQuery.pipe(
        Effect.flatMap((query) => query.getThreadDetailById(threadId)),
        Effect.map(Option.getOrThrow),
      );
      expect(thread.session?.status).toBe("stopped");
    }).pipe(Effect.provide(makeOrchestrationLayer(wrappedStore)));
  });

  effectIt.effect("rejects a preparation cancel when its anchor scan is truncated", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngineService;
      const createdAt = now();
      const seeded = yield* seedPreparationCancel(engine, {
        prefix: "truncated",
        projectId: asProjectId("project-truncated"),
        threadId: ThreadId.make("prep-cancel-truncated"),
        createdAt,
        control: "stop",
      });
      // More than a thousand non-superseding events after the anchors overflow
      // the bounded scan; a truncated scan can never pass for a checked one.
      yield* Effect.forEach(
        Array.from({ length: 1001 }, (_, index) => index),
        (index) =>
          engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(`truncated-meta-${index}`),
            threadId: ThreadId.make("prep-cancel-truncated"),
            title: `filler-${index}`,
          }),
        { concurrency: 1 },
      );
      const command = seeded.settleCommand({ status: "stopped", lastError: null });
      const error = yield* engine
        .dispatch(command, { preparationCancel: seeded.preparationCancel })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: PREPARATION_CANCEL_REJECT_DETAIL,
      });
      const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      expect(events.some((event) => event.commandId === command.commandId)).toBe(false);
    }).pipe(Effect.provide(makeOrchestrationLayer())),
  );

  effectIt.effect(
    "surfaces a cancelled anchor scan as its original interrupt-bearing cause",
    () => {
      const failAggregateReads = { current: false };
      // The store can report a read failure *and* an interrupt in one cause —
      // a preparation-cancel dispatch must deliver that cause unchanged.
      const injectedReadError = new PersistenceSqlError({
        operation: "OrchestrationEventStore.readAggregateRange:query",
        detail: "simulated preparation-cancel scan failure",
      });
      const mixedReadCause = Cause.combine(Cause.fail(injectedReadError), Cause.interrupt());
      const wrappedStore = decorateOrchestrationEventStoreLayer((store) => ({
        ...store,
        readAggregateRange: (input) => {
          if (failAggregateReads.current) {
            return Stream.failCause(mixedReadCause);
          }
          return store.readAggregateRange(input);
        },
      })).pipe(Layer.provide(OrchestrationEventStoreLive));

      const createdAt = now();
      const threadId = ThreadId.make("prep-cancel-mixed-cause");
      return Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const receipts = yield* OrchestrationCommandReceipts.OrchestrationCommandReceiptRepository;
        const seeded = yield* seedPreparationCancel(engine, {
          prefix: "mixed-cause",
          projectId: asProjectId("project-mixed-cause"),
          threadId,
          createdAt,
          control: "stop",
        });
        const command = seeded.settleCommand({ status: "stopped", lastError: null });

        failAggregateReads.current = true;
        // Effect.exit captures the delivered cause so the interrupt reason is
        // observable — Effect.flip would squash it away the same way the old
        // processEnvelope did.
        const exit = yield* Effect.exit(
          engine.dispatch(command, { preparationCancel: seeded.preparationCancel }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          // The original reasons are delivered in order — never squashed to
          // the mapped unavailable error. Propagation adds the framework's
          // own "effect/Cause/StackTrace" annotation on each reason; that is
          // the only tolerated difference from the injected cause.
          const originalReasons = Array.from(mixedReadCause.reasons);
          const deliveredReasons = Array.from(exit.cause.reasons);
          expect(deliveredReasons.map((reason) => reason._tag)).toEqual(
            originalReasons.map((reason) => reason._tag),
          );
          for (const [index, delivered] of deliveredReasons.entries()) {
            const original = originalReasons[index]!;
            if (Cause.isFailReason(delivered) && Cause.isFailReason(original)) {
              expect(delivered.error).toBe(original.error);
              expect(delivered.error).toBe(injectedReadError);
            } else if (Cause.isInterruptReason(delivered) && Cause.isInterruptReason(original)) {
              expect(delivered.fiberId).toBe(original.fiberId);
            } else {
              expect.unreachable("delivered reason kinds diverged");
            }
            for (const [key, value] of original.annotations) {
              expect(delivered.annotations.get(key)).toEqual(value);
            }
            for (const key of delivered.annotations.keys()) {
              expect(key === "effect/Cause/StackTrace" || original.annotations.has(key)).toBe(true);
            }
          }
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
          expect(Cause.hasFails(exit.cause)).toBe(true);
        }

        // Nothing was decided: no session write and no rejection receipt.
        const events = yield* Stream.runCollect(engine.readEvents(0)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        expect(events.some((event) => event.commandId === command.commandId)).toBe(false);
        expect(
          Option.isNone(yield* receipts.getByCommandId({ commandId: command.commandId })),
        ).toBe(true);

        // No poisoned receipt means the same command id can retry once the
        // store recovers — and the worker is still live to settle it.
        failAggregateReads.current = false;
        const settled = yield* engine.dispatch(command, {
          preparationCancel: seeded.preparationCancel,
        });
        expect(settled.sequence).toBeGreaterThan(seeded.control.sequence);
        const thread = yield* ProjectionSnapshotQuery.pipe(
          Effect.flatMap((query) => query.getThreadDetailById(threadId)),
          Effect.map(Option.getOrThrow),
        );
        expect(thread.session?.status).toBe("stopped");
      }).pipe(Effect.provide(makeOrchestrationLayer(wrappedStore)));
    },
  );
});
