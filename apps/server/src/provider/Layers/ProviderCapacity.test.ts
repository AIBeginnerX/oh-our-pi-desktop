import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderCapacity } from "../Services/ProviderCapacity.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { makeProviderCapacityLive } from "./ProviderCapacity.ts";

const GIB = 1024 ** 3;
// 8 GB machine: a budget of 4 live sessions keeps the scenarios small.
const BUDGET_4 = 8 * GIB;
const START = Date.parse("2026-01-01T00:00:00.000Z");

interface Session {
  readonly id: string;
  /** Minutes idle at the start of the test clock. */
  readonly idleMinutes: number;
  readonly activeTurn?: boolean;
}

const at = (minutesAgo: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(START - minutesAgo * 60_000));

const harness = (initial: ReadonlyArray<Session>) => {
  const live = new Map(initial.map((session) => [session.id, session]));
  const stopped: string[] = [];
  const layer = makeProviderCapacityLive({ totalMemBytes: BUDGET_4 }).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ProviderSessionDirectory, {
          listBindings: () =>
            Effect.succeed(
              [...live.values()].map((session) => ({
                threadId: ThreadId.make(session.id),
                provider: "claudeAgent",
                lastSeenAt: at(session.idleMinutes),
              })),
            ),
        } as never),
        Layer.succeed(ProviderService, {
          stopSession: ({ threadId }: { threadId: string }) =>
            Effect.sync(() => {
              stopped.push(threadId);
              live.delete(threadId);
            }),
        } as never),
        Layer.succeed(ProjectionSnapshotQuery, {
          getThreadShellById: (threadId: string) =>
            Effect.succeed(
              Option.map(Option.fromNullishOr(live.get(threadId)), (session) => ({
                session: {
                  updatedAt: at(session.idleMinutes),
                  activeTurnId: session.activeTurn === true ? TurnId.make("turn") : null,
                },
                backgroundLiveness: null,
              })),
            ),
        } as never),
      ),
    ),
  );
  return { live, stopped, layer };
};

const full = (extra: ReadonlyArray<Session> = []): ReadonlyArray<Session> => [
  { id: "newest", idleMinutes: 3 },
  { id: "oldest", idleMinutes: 50 },
  { id: "busy", idleMinutes: 90, activeTurn: true },
  { id: "fresh", idleMinutes: 0.5 },
  ...extra,
];

describe("ProviderCapacity.makeRoom", () => {
  it.effect("stops the longest idle session, skipping active turns and recent ones", () => {
    const h = harness(full());
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      yield* capacity.makeRoom(ThreadId.make("incoming"));
      // "busy" is the longest idle but has an active turn; "fresh" is under two minutes.
      expect(h.stopped).toEqual(["oldest"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("does nothing under budget", () => {
    const h = harness([{ id: "a", idleMinutes: 60 }]);
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      yield* capacity.makeRoom(ThreadId.make("incoming"));
      expect(h.stopped).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("never stops the thread that is starting", () => {
    const h = harness(full());
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      yield* capacity.makeRoom(ThreadId.make("oldest"));
      expect(h.stopped).toEqual(["newest"]);
    }).pipe(Effect.provide(h.layer));
  });
});

describe("ProviderCapacity.admitCrew", () => {
  it.effect("admits at once under budget", () => {
    const h = harness([{ id: "a", idleMinutes: 60 }]);
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      let waited = false;
      yield* capacity.admitCrew({ onWait: Effect.sync(() => void (waited = true)) });
      expect(waited).toBe(false);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("waits while full of busy sessions, then starts once one stops", () => {
    // Four sessions, all with active turns: nothing can be reaped.
    const h = harness([
      { id: "a", idleMinutes: 60, activeTurn: true },
      { id: "b", idleMinutes: 60, activeTurn: true },
      { id: "c", idleMinutes: 60, activeTurn: true },
      { id: "d", idleMinutes: 60, activeTurn: true },
    ]);
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      let waited = 0;
      const fiber = yield* Effect.forkChild(
        capacity.admitCrew({ onWait: Effect.sync(() => void (waited += 1)) }),
      );
      yield* TestClock.adjust(Duration.seconds(30));
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(waited).toBe(1);
      h.live.delete("a");
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(fiber);
      expect(waited).toBe(1);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("reaps an idle session itself instead of waiting", () => {
    const h = harness(full());
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      yield* capacity.admitCrew({});
      expect(h.stopped).toEqual(["oldest"]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("starts anyway after three minutes", () => {
    const h = harness([
      { id: "a", idleMinutes: 60, activeTurn: true },
      { id: "b", idleMinutes: 60, activeTurn: true },
      { id: "c", idleMinutes: 60, activeTurn: true },
      { id: "d", idleMinutes: 60, activeTurn: true },
    ]);
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      const fiber = yield* Effect.forkChild(capacity.admitCrew({}));
      yield* TestClock.adjust(Duration.seconds(179));
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust(Duration.seconds(2));
      yield* Fiber.join(fiber);
      expect(h.stopped).toEqual([]);
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("admits waiting tasks first come first served", () => {
    const h = harness([
      { id: "a", idleMinutes: 60, activeTurn: true },
      { id: "b", idleMinutes: 60, activeTurn: true },
      { id: "c", idleMinutes: 60, activeTurn: true },
      { id: "d", idleMinutes: 60, activeTurn: true },
    ]);
    return Effect.gen(function* () {
      const capacity = yield* ProviderCapacity;
      yield* TestClock.setTime(START);
      const order: string[] = [];
      const first = yield* Effect.forkChild(
        capacity.admitCrew({}).pipe(Effect.tap(() => Effect.sync(() => order.push("first")))),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      const second = yield* Effect.forkChild(
        capacity.admitCrew({}).pipe(Effect.tap(() => Effect.sync(() => order.push("second")))),
      );
      yield* TestClock.adjust(Duration.seconds(1));
      h.live.delete("a");
      yield* TestClock.adjust(Duration.seconds(5));
      expect(order).toEqual(["first"]);
      h.live.delete("b");
      yield* TestClock.adjust(Duration.seconds(5));
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      expect(order).toEqual(["first", "second"]);
    }).pipe(Effect.provide(h.layer));
  });
});
