import * as NodeOS from "node:os";

import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { ProviderCapacity, type ProviderCapacityShape } from "../Services/ProviderCapacity.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { liveSessionBudget, PRESSURE_MIN_IDLE_MS, pressureVictims } from "../sessionCapacity.ts";
import { makeIdleSessionStopper } from "./IdleSessionStopper.ts";

/** Longest a crew task waits for room; after it the task starts anyway so no wait can deadlock. */
const CREW_WAIT_CAP = Duration.minutes(3);
/**
 * There is no event for "a session stopped", so a waiting task looks again on this interval.
 * Each look is one indexed query and a few thread lookups.
 */
const RECHECK_EVERY = Duration.seconds(5);
/** An admitted task has no binding for a moment; its slot is held this long so the next one sees it. */
const RESERVATION_MS = 30_000;

export interface ProviderCapacityLiveOptions {
  /** Test seam; production reads the machine's memory. */
  readonly totalMemBytes?: number;
}

const makeProviderCapacity = (options?: ProviderCapacityLiveOptions) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory;
    const stopper = yield* makeIdleSessionStopper;
    const budget = liveSessionBudget(options?.totalMemBytes ?? NodeOS.totalmem());

    const reservations = yield* Ref.make<ReadonlyArray<number>>([]);
    const reapLock = yield* Semaphore.make(1);
    const admissionQueue = yield* Semaphore.make(1);

    /** Stops idle sessions until one more fits. True when one more fits afterwards. */
    const reap = (exceptThreadId?: string) =>
      reapLock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const held = yield* Ref.updateAndGet(reservations, (all) =>
            all.filter((expiresAt) => expiresAt > now),
          );
          const bindings = yield* directory.listBindings({ excludeStopped: true });
          const live = bindings.length + held.length;
          if (live < budget) return true;

          const inspected = yield* Effect.forEach(
            bindings.filter((binding) => binding.threadId !== exceptThreadId),
            (binding) => stopper.inspect(binding, now, PRESSURE_MIN_IDLE_MS),
          );
          const victims = pressureVictims(
            inspected.filter((entry) => entry.block === null),
            live,
            budget,
          );
          let stopped = 0;
          for (const victim of victims) {
            if (
              yield* stopper.stop(
                victim.binding.threadId,
                victim.binding,
                victim.idleMs,
                "capacity_pressure",
              )
            ) {
              stopped += 1;
            }
          }
          return live - stopped < budget;
        }),
      );

    const makeRoom: ProviderCapacityShape["makeRoom"] = (exceptThreadId) =>
      reap(exceptThreadId).pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.capacity.make-room-failed", { cause }),
        ),
      );

    const admitCrew: ProviderCapacityShape["admitCrew"] = ({ onWait }) => {
      const tryAdmit = reap().pipe(
        // A failed look must not block crew work.
        Effect.catchCause(() => Effect.succeed(true)),
        Effect.tap((fits) =>
          fits
            ? Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) =>
                  Ref.update(reservations, (all) => [...all, now + RESERVATION_MS]),
                ),
              )
            : Effect.void,
        ),
      );
      const waitForRoom = Effect.gen(function* () {
        let notified = false;
        while (!(yield* tryAdmit)) {
          if (!notified && onWait !== undefined) {
            notified = true;
            yield* onWait;
          }
          yield* Effect.sleep(RECHECK_EVERY);
        }
      });
      // First come, first served; the cap covers the time spent in line too.
      return admissionQueue
        .withPermits(1)(waitForRoom)
        .pipe(
          Effect.timeoutOption(CREW_WAIT_CAP),
          Effect.flatMap((admitted) =>
            admitted._tag === "Some"
              ? Effect.void
              : Effect.logWarning("provider.capacity.crew-wait-capped", {
                  budget,
                  waitedMs: Duration.toMillis(CREW_WAIT_CAP),
                }),
          ),
        );
    };

    yield* Effect.logInfo("provider.capacity.ready", { budget });
    return { makeRoom, admitCrew } satisfies ProviderCapacityShape;
  });

export const makeProviderCapacityLive = (options?: ProviderCapacityLiveOptions) =>
  Layer.effect(ProviderCapacity, makeProviderCapacity(options));

export const ProviderCapacityLive = makeProviderCapacityLive();
