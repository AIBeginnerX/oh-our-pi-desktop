// nextDreamRunAt needs Date's local fields, which follow DST transitions that
// UTC arithmetic cannot.
// @effect-diagnostics globalDate:off

/**
 * ProjectMemoryDreaming — the scheduled dreaming loop.
 *
 * Follows the server settings: while both `projectMemoryDreaming` and
 * `projectMemoryAnalyser` are on, sleeps (on the Effect clock, so tests drive
 * it with the TestClock) until the next local `projectMemoryDreamingHour`:00
 * and runs one analyser pass over every live project. Any settings change
 * restarts the wait, so an hour or toggle edit re-plans immediately. A wake
 * more than an hour past the target means the machine was asleep or off: that
 * day is skipped, never caught up.
 */
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ProjectMemoryAnalyser } from "./ProjectMemoryAnalyser.ts";

/** A wake more than this far past the target means the hour was missed; skip that day. */
export const DREAMING_MISSED_RUN_LIMIT_MS = 60 * 60 * 1000;

/**
 * True when a wake this far past its target means the machine was asleep or
 * off at the hour: the day is skipped, never caught up.
 */
export const isMissedDreamRun = (targetMillis: number, firedAtMillis: number): boolean =>
  firedAtMillis - targetMillis > DREAMING_MISSED_RUN_LIMIT_MS;

/**
 * The next local `hour`:00 strictly after `nowMillis`, built from Date local
 * fields so a DST transition lands on the hour the local clock actually shows.
 */
export const nextDreamRunAt = (nowMillis: number, hour: number): number => {
  const now = new Date(nowMillis);
  const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour);
  if (candidate.getTime() > nowMillis) return candidate.getTime();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, hour).getTime();
};

/** @public Layer construction is part of the canonical Effect module API. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const analyser = yield* ProjectMemoryAnalyser;
    const settingsService = yield* ServerSettings.ServerSettingsService;
    // The subscription is taken before the first snapshot read, in the layer's
    // scope, so a change racing that read still wakes the loop instead of
    // being slept through.
    const changes = yield* settingsService.subscribeChanges;
    // A change stream that ends (test doubles) parks forever instead of
    // letting the off-state wait return at once and spin the loop.
    const waitForChange = Stream.runDrain(Stream.take(Stream.concat(changes, Stream.never), 1));

    const loop = Effect.gen(function* () {
      while (true) {
        const settings = yield* settingsService.getSettings.pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        if (
          settings === null ||
          !settings.projectMemoryDreaming ||
          !settings.projectMemoryAnalyser
        ) {
          // Off (or unreadable): park until the next change and re-check.
          yield* waitForChange;
          continue;
        }
        const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
        const targetMillis = nextDreamRunAt(nowMillis, settings.projectMemoryDreamingHour);
        const woken = yield* Effect.race(
          Effect.sleep(Duration.millis(targetMillis - nowMillis)).pipe(Effect.as("fire" as const)),
          waitForChange.pipe(Effect.as("replan" as const)),
        );
        if (woken === "replan") continue;
        const firedAtMillis = DateTime.toEpochMillis(yield* DateTime.now);
        if (isMissedDreamRun(targetMillis, firedAtMillis)) continue;
        yield* analyser.dream.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) => Effect.logWarning("project memory dreaming run failed", { cause }),
          ),
        );
      }
    });

    yield* forkParked(loop);
  }),
);
