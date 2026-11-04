import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  PLAN_CONTINUATION_CAP,
  PLAN_CONTINUATION_FRESH_MS,
  PLAN_CONTINUED_ACTIVITY,
  ThreadPlanContinuationReactor,
  decidePlanContinuation,
  layer,
  planContinuationPrompt,
} from "./ThreadPlanContinuationReactor.ts";

const SERVER_STARTED_AT = "2026-10-15T00:00:00.000Z";
const TURN_COMPLETED_AT = "2026-10-15T00:09:30.000Z";
const NOW = Date.parse("2026-10-15T00:10:00.000Z");
const THREAD_ID = ThreadId.make("thread-1");

type Shell = Parameters<typeof decidePlanContinuation>[0]["shell"];
type Detail = Pick<OrchestrationThread, "messages" | "activities">;

const shell = (
  overrides: Partial<Shell> & { readonly crew?: OrchestrationThread["crew"] } = {},
): Shell =>
  ({
    title: "Fix the login flow",
    interactionMode: "default",
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
    session: { status: "ready", lastError: null },
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-10-15T00:05:00.000Z",
      startedAt: "2026-10-15T00:05:00.000Z",
      completedAt: TURN_COMPLETED_AT,
      assistantMessageId: "reply-1",
    },
    ...overrides,
  }) as unknown as Shell;

const plan = (turnId: string, statuses: ReadonlyArray<string>, sequence = 1) => ({
  kind: "turn.plan.updated",
  turnId,
  sequence,
  createdAt: `2026-10-15T00:06:${String(sequence).padStart(2, "0")}.000Z`,
  payload: { plan: statuses.map((status, index) => ({ step: `step ${index + 1}`, status })) },
});

const continued = (turnId: string, messageId: string, completedSteps: number) => ({
  kind: PLAN_CONTINUED_ACTIVITY,
  turnId,
  sequence: 50,
  createdAt: TURN_COMPLETED_AT,
  payload: { turnId, messageId, completedSteps },
});

const userMessage = (id: string, createdAt: string) => ({ id, role: "user", createdAt });

const detail = (
  activities: ReadonlyArray<unknown>,
  messages: ReadonlyArray<unknown> = [userMessage("human-1", "2026-10-15T00:05:00.000Z")],
) => ({ activities, messages }) as unknown as Detail;

const decide = (s: Shell, d: Detail, now = NOW) =>
  decidePlanContinuation({ shell: s, detail: d, now, serverStartedAt: SERVER_STARTED_AT });

const unfinished = detail([plan("turn-1", ["completed", "inProgress", "pending"])]);

describe("decidePlanContinuation", () => {
  it("continues once when a turn ends with unfinished plan steps", () => {
    const decision = decide(shell(), unfinished);
    expect(decision).toEqual({
      kind: "continue",
      attempt: 1,
      completedSteps: 1,
      totalSteps: 3,
      remaining: ["step 2", "step 3"],
    });
    assert(decision.kind === "continue");
    expect(planContinuationPrompt(decision)).toContain("- step 2");
  });

  it("reads the turn's latest plan, not an earlier snapshot of it", () => {
    const finished = detail([
      plan("turn-1", ["pending", "pending"], 1),
      plan("turn-1", ["completed", "completed"], 2),
    ]);
    expect(decide(shell(), finished)).toEqual({ kind: "none" });
  });

  describe("never fires when", () => {
    const blocked: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      [
        "the turn was interrupted",
        { latestTurn: { ...shell().latestTurn!, state: "interrupted" } },
      ],
      ["the turn failed", { latestTurn: { ...shell().latestTurn!, state: "error" } }],
      ["the turn is still running", { latestTurn: { ...shell().latestTurn!, state: "running" } }],
      ["the turn has no end time", { latestTurn: { ...shell().latestTurn!, completedAt: null } }],
      ["there is no turn", { latestTurn: null }],
      ["an approval is pending", { hasPendingApprovals: true }],
      ["user input is pending", { hasPendingUserInput: true }],
      ["background subagents are live", { backgroundLiveness: "working" }],
      ["only a background monitor is live", { backgroundLiveness: "monitoring" }],
      ["the thread is a crew member", { title: "Crew Worker · write the tests" }],
      ["the thread is in plan mode", { interactionMode: "plan" }],
      ["the thread is archived", { archivedAt: "2026-10-15T00:09:40.000Z" }],
      ["the session is still running", { session: { status: "running", lastError: null } }],
      ["the session errored", { session: { status: "error", lastError: "boom" } }],
      ["the session was interrupted", { session: { status: "interrupted", lastError: null } }],
      ["the session is gone", { session: null }],
    ];
    for (const [name, overrides] of blocked) {
      it(name, () => {
        expect(decide(shell(overrides as Partial<Shell>), unfinished)).toEqual({ kind: "none" });
      });
    }

    it("the turn ended before this server started (a reconnect replaying an old thread)", () => {
      const old = shell({
        latestTurn: { ...shell().latestTurn!, completedAt: "2026-10-14T23:00:00.000Z" },
      });
      expect(decide(old, unfinished)).toEqual({ kind: "none" });
    });

    it("the turn ended too long ago to be the one that was just reviewed", () => {
      expect(decide(shell(), unfinished, NOW + PLAN_CONTINUATION_FRESH_MS)).toEqual({
        kind: "none",
      });
    });

    it("the user already sent a message after the turn ended", () => {
      const queued = detail(unfinished.activities, [
        userMessage("human-1", "2026-10-15T00:05:00.000Z"),
        userMessage("human-2", "2026-10-15T00:09:45.000Z"),
      ]);
      expect(decide(shell(), queued)).toEqual({ kind: "none" });
    });

    it("the provider sent no plan for this turn", () => {
      expect(decide(shell(), detail([]))).toEqual({ kind: "none" });
      expect(decide(shell(), detail([plan("turn-0", ["pending"])]))).toEqual({ kind: "none" });
    });

    it("every plan step is already completed", () => {
      expect(decide(shell(), detail([plan("turn-1", ["completed", "completed"])]))).toEqual({
        kind: "none",
      });
    });

    it("this turn was already continued", () => {
      const handled = detail([...unfinished.activities, continued("turn-1", "own-1", 1)]);
      expect(decide(shell(), handled)).toEqual({ kind: "none" });
    });
  });

  describe("cap and progress", () => {
    const messagesAfter = (...ownIds: ReadonlyArray<string>) => [
      userMessage("human-1", "2026-10-15T00:01:00.000Z"),
      ...ownIds.map((id, index) => userMessage(id, `2026-10-15T00:0${2 + index}:00.000Z`)),
    ];

    it("sends a second continuation only when the first completed a new step", () => {
      const progressed = detail(
        [continued("turn-0", "own-1", 0), plan("turn-1", ["completed", "pending"])],
        messagesAfter("own-1"),
      );
      expect(decide(shell(), progressed)).toMatchObject({ kind: "continue", attempt: 2 });
    });

    it("stops when the continuation completed nothing new", () => {
      const stalled = detail(
        [continued("turn-0", "own-1", 1), plan("turn-1", ["completed", "pending"])],
        messagesAfter("own-1"),
      );
      expect(decide(shell(), stalled)).toEqual({ kind: "none" });
    });

    it("stops when the continuation sent no plan at all", () => {
      const silent = detail([continued("turn-0", "own-1", 1)], messagesAfter("own-1"));
      expect(decide(shell(), silent)).toEqual({ kind: "none" });
    });

    it(`never sends more than ${PLAN_CONTINUATION_CAP} per user message, however much progress`, () => {
      const capped = detail(
        [
          continued("turn-a", "own-1", 0),
          continued("turn-b", "own-2", 1),
          plan("turn-1", ["completed", "completed", "pending"]),
        ],
        messagesAfter("own-1", "own-2"),
      );
      expect(decide(shell(), capped)).toEqual({ kind: "none" });
    });

    it("counts again from zero once the user sends a message", () => {
      const reset = detail(
        [
          continued("turn-a", "own-1", 0),
          continued("turn-b", "own-2", 1),
          plan("turn-1", ["pending", "pending"]),
        ],
        [...messagesAfter("own-1", "own-2"), userMessage("human-2", "2026-10-15T00:04:00.000Z")],
      );
      expect(decide(shell(), reset)).toMatchObject({ kind: "continue", attempt: 1 });
    });

    it("keeps the cap across a restart, because it is read from persisted activity", () => {
      // Nothing in memory is consulted: the same persisted history gives the same answer.
      const persisted = detail(
        [
          continued("turn-a", "own-1", 0),
          continued("turn-b", "own-2", 1),
          plan("turn-1", ["completed", "pending"]),
        ],
        messagesAfter("own-1", "own-2"),
      );
      expect(decide(shell(), persisted)).toEqual(decide(shell(), persisted));
      expect(decide(shell(), persisted)).toEqual({ kind: "none" });
    });
  });
});

const makeHarness = Effect.fn("makePlanContinuationHarness")(function* (input: {
  readonly settings: Partial<ServerSettings>;
  readonly shell: Shell;
  readonly detail: Detail;
}) {
  const settings = { ...DEFAULT_SERVER_SETTINGS, ...input.settings };
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const shellReads = yield* Ref.make(0);
  const settingsReads = yield* Queue.unbounded<ServerSettings>();
  const events = yield* PubSub.unbounded<OrchestrationEvent>();

  const dependencies = Layer.mergeAll(
    Layer.mock(OrchestrationEngineService)({
      dispatch: (command) =>
        Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 })),
      subscribeDomainEvents: PubSub.subscribe(events).pipe(
        Effect.map((subscription) => Stream.fromSubscription(subscription)),
      ),
    }),
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () =>
        Ref.update(shellReads, (count) => count + 1).pipe(
          Effect.andThen(Effect.succeedSome(input.shell as never)),
        ),
      getThreadDetailById: () => Effect.succeedSome(input.detail as never),
    }),
    Layer.succeed(
      ServerSettingsService,
      ServerSettingsService.of({
        start: Effect.void,
        ready: Effect.void,
        getSettings: Queue.offer(settingsReads, settings).pipe(Effect.as(settings)),
        updateSettings: () => Effect.succeed(settings),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
    ),
    Layer.succeed(
      Crypto.Crypto,
      Crypto.make({
        randomBytes: (size) => new Uint8Array(size).fill(1),
        digest: (_algorithm, data) => Effect.succeed(data),
      }),
    ),
  );

  /** Ends the thread's turn, waits for the review that follows, and returns what was dispatched. */
  const endTurn = Effect.gen(function* () {
    const reactor = yield* ThreadPlanContinuationReactor;
    yield* reactor.start();
    yield* PubSub.publish(events, {
      type: "thread.session-set",
      payload: { threadId: THREAD_ID, session: { status: "ready" } },
    } as unknown as OrchestrationEvent);
    yield* Queue.take(settingsReads);
    yield* reactor.drain;
    return {
      commands: yield* Ref.get(commands),
      shellReads: yield* Ref.get(shellReads),
    };
  });

  return { endTurn, layer: layer.pipe(Layer.provide(dependencies)) };
});

const runTurnEnd = (input: {
  readonly settings: Partial<ServerSettings>;
  readonly shell?: Shell;
  readonly detail?: Detail;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(SERVER_STARTED_AT));
      const harness = yield* makeHarness({
        settings: input.settings,
        shell: input.shell ?? shell(),
        detail: input.detail ?? unfinished,
      });
      // The reactor stamps its start time when built; the turn then ends 9.5 minutes later.
      return yield* Effect.provide(
        TestClock.setTime(Date.parse(TURN_COMPLETED_AT) + 5_000).pipe(
          Effect.andThen(harness.endTurn),
        ),
        harness.layer,
      );
    }),
  );

describe("ThreadPlanContinuationReactor", () => {
  it.effect("dispatches nothing, and reads nothing but the setting, while the setting is off", () =>
    Effect.gen(function* () {
      expect(DEFAULT_SERVER_SETTINGS.continueUnfinishedPlans).toBe(false);
      const result = yield* runTurnEnd({ settings: {} });
      expect(result.commands).toEqual([]);
      expect(result.shellReads).toBe(0);
    }),
  );

  it.effect("records the continuation, then starts its turn, when the setting is on", () =>
    Effect.gen(function* () {
      const result = yield* runTurnEnd({ settings: { continueUnfinishedPlans: true } });
      expect(result.commands.map((command) => command.type)).toEqual([
        "thread.activity.append",
        "thread.turn.start",
      ]);
      const [record, start] = result.commands;
      assert(record?.type === "thread.activity.append" && start?.type === "thread.turn.start");
      expect(record.commandId).toBe("server:plan-continue:thread-1:turn-1");
      expect(start.commandId).toBe("server:plan-turn:thread-1:turn-1");
      expect(record.activity.kind).toBe(PLAN_CONTINUED_ACTIVITY);
      expect(record.activity.payload).toMatchObject({
        turnId: "turn-1",
        messageId: start.message.messageId,
        completedSteps: 1,
      });
    }),
  );

  it.effect("dispatches nothing while a goal is active on the thread", () =>
    Effect.gen(function* () {
      const result = yield* runTurnEnd({
        settings: {
          continueUnfinishedPlans: true,
          threadGoals: {
            [THREAD_ID]: {
              id: "goal-1",
              text: "Ship it",
              maxContinues: 5,
              active: true,
              setAt: "2026-10-15T00:00:00.000Z",
            },
          },
        } as unknown as Partial<ServerSettings>,
      });
      expect(result.commands).toEqual([]);
    }),
  );

  it.effect("dispatches nothing while Crew is on for the thread", () =>
    Effect.gen(function* () {
      const result = yield* runTurnEnd({
        settings: { continueUnfinishedPlans: true },
        shell: shell({ crew: { enabled: true } }),
      });
      expect(result.commands).toEqual([]);
      const wholeServer = yield* runTurnEnd({
        settings: {
          continueUnfinishedPlans: true,
          crew: { ...DEFAULT_SERVER_SETTINGS.crew, enabled: true },
        },
      });
      expect(wholeServer.commands).toEqual([]);
    }),
  );

  it.effect("lets a thread that switched Crew off continue when the default has it on", () =>
    Effect.gen(function* () {
      const result = yield* runTurnEnd({
        settings: {
          continueUnfinishedPlans: true,
          crew: { ...DEFAULT_SERVER_SETTINGS.crew, enabled: true },
        },
        shell: shell({ crew: { enabled: false } }),
      });
      expect(result.commands).not.toEqual([]);
    }),
  );

  it.effect("dispatches nothing when the shell says something is still pending", () =>
    Effect.gen(function* () {
      const result = yield* runTurnEnd({
        settings: { continueUnfinishedPlans: true },
        shell: shell({ hasPendingApprovals: true }),
      });
      expect(result.commands).toEqual([]);
    }),
  );
});
