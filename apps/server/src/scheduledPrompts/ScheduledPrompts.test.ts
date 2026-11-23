// @effect-diagnostics globalDate:off
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScheduledPrompt,
  type ServerSettings,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadMessageRepositoryLive } from "../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as RestartContinuations from "../restartContinuations.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { layer, runOccurrence } from "./ScheduledPrompts.ts";

const base = new Date(2026, 10, 16, 9, 0).getTime();
const target = new Date(2026, 10, 16, 9, 15).getTime();
const schedules: ScheduledPrompt = {
  id: "daily",
  projectId: ProjectId.make("project"),
  title: "New thread",
  prompt: "  Review open issues.\n",
  enabled: true,
  hour: 9,
  minute: 15,
};
// Close enough to the target that the scheduler waits on one timer for it.
const near = target - 30_000;
const threadId = ThreadId.make("scheduled-prompt:daily:2026-11-16T09:15");
const settings = {
  ...DEFAULT_SERVER_SETTINGS,
  scheduledPrompts: [schedules],
  projectSettingsOverrides: {
    [schedules.projectId]: { defaultRuntimeMode: "approval-required" as const },
  },
};

const testLayer = Layer.merge(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(RestartContinuations.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(ProjectionTurnRepositoryLive),
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-scheduled-prompts-" })),
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(Layer.mock(ProviderRegistry, { getProviders: Effect.succeed([]) })),
);

const createProject = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  yield* engine.dispatch({
    type: "project.create",
    commandId: CommandId.make("create-project"),
    projectId: schedules.projectId,
    title: "Project",
    workspaceRoot: process.cwd(),
    createdAt: DateTime.formatIso(DateTime.makeUnsafe(base)),
  });
});

/**
 * Starts the scheduler at `start`. `wakeLateBy` moves the wall clock forward once the first timer
 * returns, which is what a machine that slept through that timer sees.
 */
const setupScheduler = Effect.fnUntraced(function* (
  initial: ServerSettings,
  options?: {
    readonly start?: number;
    readonly wakeLateBy?: number;
    readonly beforeCleanupWrite?: Effect.Effect<void>;
  },
) {
  let current = initial;
  const changed = yield* PubSub.unbounded<ServerSettings>();
  const timers = yield* Queue.unbounded<number>();
  const removed = yield* Deferred.make<ReadonlyArray<ScheduledPrompt>>();
  const clock = yield* Clock.Clock;
  let offset = 0;
  const adjustedClock: Clock.Clock = {
    currentTimeMillis: clock.currentTimeMillis.pipe(Effect.map((ms) => ms + offset)),
    currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe() + offset,
    currentTimeNanos: clock.currentTimeNanos,
    currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
    monotonicTimeNanos: clock.monotonicTimeNanos,
    monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
    sleep: (duration) =>
      Queue.offer(timers, Duration.toMillis(duration)).pipe(
        Effect.andThen(clock.sleep(duration)),
        Effect.tap(() =>
          Effect.sync(() => {
            offset = options?.wakeLateBy ?? 0;
          }),
        ),
      ),
  };
  const settingsLayer = Layer.mock(ServerSettingsService, {
    getSettings: Effect.sync(() => current),
    updateSettings: (patch) =>
      Effect.gen(function* () {
        yield* options?.beforeCleanupWrite ?? Effect.void;
        current = applyServerSettingsPatch(current, patch);
        yield* Deferred.succeed(removed, current.scheduledPrompts);
        return current;
      }),
    subscribeChanges: PubSub.subscribe(changed).pipe(Effect.map(Stream.fromSubscription)),
  });
  yield* TestClock.setTime(options?.start ?? base);
  yield* Layer.build(layer.pipe(Layer.provide(settingsLayer))).pipe(
    Effect.provideService(Clock.Clock, adjustedClock),
  );
  yield* Queue.take(timers);
  return {
    /**
     * Resolves once a timer of this length is set, which the scheduler does after planning. A
     * run sets shorter timers of its own inside the engine, so any timer is not enough.
     */
    timerSet: (millis: number) =>
      Queue.take(timers).pipe(Effect.repeat({ until: (set) => set === millis })),
    removed: Deferred.await(removed),
    update: (next: ServerSettings) =>
      Effect.sync(() => {
        current = next;
      }).pipe(Effect.andThen(PubSub.publish(changed, next))),
  };
});

const awaitRun = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const events = yield* engine.subscribeDomainEvents;
  return {
    completed: events.pipe(
      Stream.filter(
        (event) =>
          event.type === "thread.activity-appended" &&
          event.payload.activity.kind === "scheduled-prompt.started",
      ),
      Stream.runHead,
    ),
  };
});

it.layer(Layer.empty)("Scheduled prompts", (it) => {
  it.effect("creates a thread and starts the saved prompt at the configured minute", () =>
    Effect.gen(function* () {
      yield* createProject;
      const { completed } = yield* awaitRun;
      yield* setupScheduler(settings, { start: near });
      const snapshots = yield* ProjectionSnapshotQuery;
      yield* TestClock.setTime(target - 1);
      assert.isTrue(Option.isNone(yield* snapshots.getThreadShellById(threadId)));
      yield* TestClock.setTime(target);
      yield* completed;
      const thread = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
      assert.equal(thread.title, schedules.title);
      assert.equal(thread.titleState?.source, "manual");
      assert.equal(thread.runtimeMode, "approval-required");
      assert.equal(thread.interactionMode, "default");
      assert.isNull(thread.worktreePath);
      assert.equal(thread.messages[0]?.text, schedules.prompt);
      assert.deepInclude(thread.activities[0], {
        kind: "scheduled-prompt.started",
        turnId: null,
        payload: { scheduleId: schedules.id, title: schedules.title },
      });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("re-plans after settings change", () =>
    Effect.gen(function* () {
      yield* createProject;
      const { completed } = yield* awaitRun;
      const { update, timerSet } = yield* setupScheduler(
        { ...settings, scheduledPrompts: [{ ...schedules, hour: 13 }] },
        { start: near },
      );
      yield* update(settings);
      yield* timerSet(target - near);
      yield* TestClock.setTime(target);
      assert.isTrue(Option.isSome(yield* completed));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  // The scheduler starts 15 minutes early and first looks at the clock after one minute. A
  // machine asleep for another 74 minutes wakes exactly one hour after the occurrence.
  const sleptToTheLimit = 74 * 60_000;

  it.effect("runs an occurrence the machine slept through when it wakes within the hour", () =>
    Effect.gen(function* () {
      yield* createProject;
      const { completed } = yield* awaitRun;
      yield* setupScheduler(settings, { wakeLateBy: sleptToTheLimit });
      yield* TestClock.adjust(60_000);
      assert.isTrue(Option.isSome(yield* completed));
      const snapshots = yield* ProjectionSnapshotQuery;
      assert.isTrue(Option.isSome(yield* snapshots.getThreadShellById(threadId)));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips an occurrence that would start more than one hour late", () =>
    Effect.gen(function* () {
      yield* createProject;
      const { timerSet } = yield* setupScheduler(settings, { wakeLateBy: sleptToTheLimit + 1 });
      yield* TestClock.adjust(60_000);
      // By its next one-minute timer the scheduler has dealt with the occurrence and planned
      // tomorrow's.
      yield* timerSet(60_000);
      const snapshots = yield* ProjectionSnapshotQuery;
      assert.isTrue(Option.isNone(yield* snapshots.getThreadShellById(threadId)));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("removes every entry of a deleted project when one of them comes due", () =>
    Effect.gen(function* () {
      const kept = { ...schedules, id: "kept", projectId: ProjectId.make("other"), hour: 13 };
      const { removed } = yield* setupScheduler(
        {
          ...settings,
          scheduledPrompts: [schedules, kept, { ...schedules, id: "off", enabled: false }],
        },
        { start: near },
      );
      yield* TestClock.setTime(target);
      assert.deepEqual(yield* removed, [kept]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps a concurrent save when cleaning up a deleted project", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const saved = { ...schedules, id: "saved", projectId: ProjectId.make("other") };
      const { removed, update } = yield* setupScheduler(settings, {
        start: near,
        beforeCleanupWrite: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        ),
      });
      yield* TestClock.setTime(target);
      yield* Deferred.await(entered);
      yield* update({ ...settings, scheduledPrompts: [schedules, saved] });
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* removed, [saved]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "resumes an occurrence after create and replays a completed run without new events",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(target);
        yield* createProject;
        const engine = yield* OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery;
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`server:create:${threadId}`),
          threadId,
          projectId: schedules.projectId,
          title: schedules.title,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: DEFAULT_MODEL },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: DateTime.formatIso(DateTime.makeUnsafe(target)),
        });
        const { completed } = yield* awaitRun;
        yield* runOccurrence(schedules, settings, target);
        assert.isTrue(Option.isSome(yield* completed));
        const sequence = yield* engine.latestSequence;
        yield* runOccurrence(schedules, settings, target);
        assert.equal(yield* engine.latestSequence, sequence);
        const thread = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
        assert.lengthOf(thread.messages, 1);
        assert.lengthOf(thread.activities, 1);
        // An entry moved to a later time the same day runs again, in a thread of its own.
        yield* runOccurrence({ ...schedules, minute: 30 }, settings, target + 15 * 60_000);
        const later = ThreadId.make("scheduled-prompt:daily:2026-11-16T09:30");
        assert.isTrue(Option.isSome(yield* snapshots.getThreadShellById(later)));
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("skips disabled entries and entries for a deleted project", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(target);
      yield* createProject;
      const engine = yield* OrchestrationEngineService;
      const created = yield* engine.latestSequence;
      yield* runOccurrence({ ...schedules, enabled: false }, settings, target);
      assert.equal(yield* engine.latestSequence, created);
      yield* engine.dispatch({
        type: "project.delete",
        commandId: CommandId.make("delete-project"),
        projectId: schedules.projectId,
      });
      const deleted = yield* engine.latestSequence;
      yield* runOccurrence(schedules, settings, target);
      assert.equal(yield* engine.latestSequence, deleted);
    }).pipe(Effect.provide(testLayer)),
  );
});
