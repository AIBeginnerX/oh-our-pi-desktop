// @effect-diagnostics nodeBuiltinImport:off
// Every time below is built from Date local fields so the expectations hold in
// any timezone and exercise DST transitions.
// @effect-diagnostics globalDate:off globalDateInEffect:off

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";

import { ServerSettingsService } from "../serverSettings.ts";
import { ProjectMemoryAnalyser, type ProjectMemoryDreamResult } from "./ProjectMemoryAnalyser.ts";
import {
  DREAMING_MISSED_RUN_LIMIT_MS,
  isMissedDreamRun,
  layer as dreamingLayer,
  nextDreamRunAt,
} from "./ProjectMemoryDreaming.ts";

// 13:30 local. Every expectation in this file is built from Date local fields,
// so the tests hold in any timezone the machine runs in.
const BASE = new Date(2026, 10, 16, 13, 30, 0, 0).getTime();

interface Fixture {
  settings: ServerSettings;
  readonly changes: PubSub.PubSub<ServerSettings>;
  dreamCalls: number;
  readonly dreamed: Deferred.Deferred<void>;
}

const makeFixture = (overrides: {
  readonly projectMemoryDreaming: boolean;
  readonly projectMemoryAnalyser: boolean;
  readonly projectMemoryDreamingHour: number;
}) =>
  Effect.gen(function* () {
    const dreamed = yield* Deferred.make<void>();
    const changes = yield* PubSub.unbounded<ServerSettings>();
    const fixture: Fixture = {
      settings: { ...DEFAULT_SERVER_SETTINGS, ...overrides },
      changes,
      dreamCalls: 0,
      dreamed,
    };
    return fixture;
  });

const settingsLayer = (fixture: Fixture) =>
  Layer.mock(ServerSettingsService, {
    getSettings: Effect.sync(() => fixture.settings),
    subscribeChanges: Effect.map(PubSub.subscribe(fixture.changes), (subscription) =>
      Stream.fromSubscription(subscription),
    ),
  });

const analyserLayer = (fixture: Fixture) =>
  Layer.mock(ProjectMemoryAnalyser, {
    dream: Effect.gen(function* () {
      fixture.dreamCalls += 1;
      yield* Deferred.succeed(fixture.dreamed, undefined);
      const result: ProjectMemoryDreamResult = { projects: 0, failed: 0 };
      return result;
    }),
  });

/** Builds the dreaming layer (which forks its loop) and runs the body in its scope. */
const runWithDreaming = <A, E>(fixture: Fixture, run: Effect.Effect<A, E>) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* Layer.build(
        dreamingLayer.pipe(
          Layer.provide(settingsLayer(fixture)),
          Layer.provide(analyserLayer(fixture)),
        ),
      );
      return yield* run;
    }),
  );

/** Lets a woken loop fiber finish its current iteration before assertions. */
const settle = Effect.flatMap(Effect.yieldNow, () => Effect.yieldNow);

describe("nextDreamRunAt", () => {
  it("returns today's hour when it is still ahead", () => {
    const now = new Date(2026, 5, 10, 1, 45, 0, 0).getTime();
    assert.equal(nextDreamRunAt(now, 3), new Date(2026, 5, 10, 3, 0, 0, 0).getTime());
  });

  it("returns tomorrow's hour once today's has passed", () => {
    const now = new Date(2026, 5, 10, 3, 0, 1, 0).getTime();
    assert.equal(nextDreamRunAt(now, 3), new Date(2026, 5, 11, 3, 0, 0, 0).getTime());
  });

  it("is strictly after now, even when now is exactly the hour", () => {
    const now = new Date(2026, 5, 10, 3, 0, 0, 0).getTime();
    assert.equal(nextDreamRunAt(now, 3), new Date(2026, 5, 11, 3, 0, 0, 0).getTime());
  });

  it("wraps past midnight to the next day", () => {
    const now = new Date(2026, 5, 10, 23, 30, 0, 0).getTime();
    assert.equal(nextDreamRunAt(now, 0), new Date(2026, 5, 11, 0, 0, 0, 0).getTime());
  });

  it("flags a wake more than an hour past the target as missed", () => {
    const target = new Date(2026, 5, 10, 3, 0, 0, 0).getTime();
    assert.isFalse(isMissedDreamRun(target, target));
    assert.isFalse(isMissedDreamRun(target, target + DREAMING_MISSED_RUN_LIMIT_MS));
    assert.isTrue(isMissedDreamRun(target, target + DREAMING_MISSED_RUN_LIMIT_MS + 1));
  });

  it("is strictly after now and within a day, across DST transitions and every hour", () => {
    // Sample real instants around the US and EU 2026 transitions; the helper
    // must stay correct whichever zone this machine runs in.
    const nows = [
      Date.now(),
      Date.UTC(2026, 2, 8, 6, 30),
      Date.UTC(2026, 2, 8, 7, 30),
      Date.UTC(2026, 10, 1, 5, 30),
      Date.UTC(2026, 9, 25, 0, 30),
      Date.UTC(2027, 0, 1, 0, 0),
    ];
    for (const now of nows) {
      for (const hour of [0, 2, 12, 23]) {
        const target = nextDreamRunAt(now, hour);
        assert.isAbove(target, now);
        assert.isAtMost(target - now, 26 * 60 * 60 * 1000);
      }
    }
  });
});

describe("ProjectMemoryDreaming", () => {
  it.effect("runs the analyser at the configured local hour", () =>
    Effect.gen(function* () {
      const hour = new Date(BASE).getHours() + 1; // half an hour out
      const target = nextDreamRunAt(BASE, hour);
      const fixture = yield* makeFixture({
        projectMemoryDreaming: true,
        projectMemoryAnalyser: true,
        projectMemoryDreamingHour: hour,
      });
      yield* TestClock.setTime(BASE);
      yield* runWithDreaming(
        fixture,
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.millis(target - BASE));
          yield* Deferred.await(fixture.dreamed);
          assert.equal(fixture.dreamCalls, 1);
        }),
      );
    }),
  );

  it.effect("does not run while projectMemoryDreaming is off", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        projectMemoryDreaming: false,
        projectMemoryAnalyser: true,
        projectMemoryDreamingHour: new Date(BASE).getHours() + 1,
      });
      yield* TestClock.setTime(BASE);
      yield* runWithDreaming(
        fixture,
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.hours(30));
          yield* settle;
          assert.equal(fixture.dreamCalls, 0);
        }),
      );
    }),
  );

  it.effect("does not run while the analyser is off", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        projectMemoryDreaming: true,
        projectMemoryAnalyser: false,
        projectMemoryDreamingHour: new Date(BASE).getHours() + 1,
      });
      yield* TestClock.setTime(BASE);
      yield* runWithDreaming(
        fixture,
        Effect.gen(function* () {
          yield* TestClock.adjust(Duration.hours(30));
          yield* settle;
          assert.equal(fixture.dreamCalls, 0);
        }),
      );
    }),
  );

  it.effect("does not catch up on a passed hour and runs the next day's hour", () =>
    Effect.gen(function* () {
      // The hour passed two hours ago (the machine was asleep): today is lost.
      const hour = new Date(BASE).getHours() - 2;
      const fixture = yield* makeFixture({
        projectMemoryDreaming: true,
        projectMemoryAnalyser: true,
        projectMemoryDreamingHour: hour,
      });
      yield* TestClock.setTime(BASE);
      yield* runWithDreaming(
        fixture,
        Effect.gen(function* () {
          yield* settle;
          assert.equal(fixture.dreamCalls, 0);
          // The next day's hour still runs.
          yield* TestClock.adjust(Duration.millis(nextDreamRunAt(BASE, hour) - BASE));
          yield* Deferred.await(fixture.dreamed);
          assert.equal(fixture.dreamCalls, 1);
        }),
      );
    }),
  );

  it.effect("re-plans when the hour changes", () =>
    Effect.gen(function* () {
      const farHour = new Date(BASE).getHours() + 10; // hours away
      const fixture = yield* makeFixture({
        projectMemoryDreaming: true,
        projectMemoryAnalyser: true,
        projectMemoryDreamingHour: farHour,
      });
      yield* TestClock.setTime(BASE);
      yield* runWithDreaming(
        fixture,
        Effect.gen(function* () {
          const nearHour = new Date(BASE).getHours() + 1;
          fixture.settings = { ...fixture.settings, projectMemoryDreamingHour: nearHour };
          yield* PubSub.publish(fixture.changes, fixture.settings);
          yield* settle;
          yield* TestClock.adjust(Duration.millis(nextDreamRunAt(BASE, nearHour) - BASE));
          yield* Deferred.await(fixture.dreamed);
          assert.equal(fixture.dreamCalls, 1);
        }),
      );
    }),
  );
});
