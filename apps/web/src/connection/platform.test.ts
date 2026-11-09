import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  type CachedPlatformRegistration,
  earliestRefreshAtEpochMs,
  platformRegistrationRefreshes,
  primaryRegistrationToRetainAfterTopologyRead,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: { readonly failDescriptor?: boolean },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: "pairing-token",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

describe("earliest cached refresh deadline", () => {
  const entry = (refreshAtEpochMs?: number): CachedPlatformRegistration =>
    refreshAtEpochMs === undefined
      ? { signature: "signature", registration: {} as never }
      : { signature: "signature", registration: {} as never, refreshAtEpochMs };

  it("is undefined while nothing cached schedules a refresh", () => {
    expect(earliestRefreshAtEpochMs(new Map())).toBeUndefined();
    expect(earliestRefreshAtEpochMs(new Map([["primary", entry()]]))).toBeUndefined();
  });

  it("is the earliest bearer refresh deadline", () => {
    const cache = new Map<string, CachedPlatformRegistration>([
      ["primary", entry()],
      ["wsl:b", entry(20_000)],
      ["wsl:a", entry(10_000)],
    ]);

    expect(earliestRefreshAtEpochMs(cache)).toBe(10_000);
  });
});

describe("platform registration refresh", () => {
  // Timer callbacks and stream elements resume on the fiber scheduler after
  // TestClock.adjust returns; drain the queue before asserting on counters.
  const settle = Effect.gen(function* () {
    for (let iteration = 0; iteration < 20; iteration += 1) {
      yield* Effect.yieldNow;
    }
  });

  const countingRebuild = (rebuilds: Ref.Ref<number>) =>
    Ref.update(rebuilds, (count) => count + 1).pipe(Effect.as([] as ReadonlyArray<never>));

  // No cached credential is pending a re-issue.
  const noRefreshDeadline: Effect.Effect<Option.Option<number>> = Effect.succeedNone;

  const runCollecting = <A>(stream: Stream.Stream<A>) =>
    Effect.gen(function* () {
      const received = yield* Ref.make<ReadonlyArray<A>>([]);
      const fiber = yield* Stream.runForEach(stream, (value) =>
        Ref.update(received, (values) => [...values, value]),
      ).pipe(Effect.forkChild);
      return { received, fiber } as const;
    });

  it.effect("rebuilds when a bootstraps change event arrives", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const events = yield* Queue.unbounded<void>();
      const stream = platformRegistrationRefreshes({
        changeEvents: Stream.fromQueue(events),
        rebuild: countingRebuild(rebuilds),
        nextRefreshAtEpochMs: noRefreshDeadline,
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      Queue.offerUnsafe(events, undefined);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(2);
      expect(yield* Ref.get(consumer.received)).toHaveLength(2);

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );

  it.effect("does not rebuild between events, even across the old poll window", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const events = yield* Queue.unbounded<void>();
      const stream = platformRegistrationRefreshes({
        changeEvents: Stream.fromQueue(events),
        rebuild: countingRebuild(rebuilds),
        nextRefreshAtEpochMs: noRefreshDeadline,
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      yield* TestClock.adjust("3 seconds");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);
      expect(yield* Ref.get(consumer.received)).toHaveLength(1);

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );

  it.effect("re-issues bearer credentials at the earliest cached refresh deadline", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const cache = yield* Ref.make(new Map<string, CachedPlatformRegistration>());
      const rebuild = Effect.gen(function* () {
        yield* Ref.update(rebuilds, (count) => count + 1);
        // A fresh secondary bearer: expires in 60 minutes, refresh 5s early.
        const issuedAtEpochMs = yield* Clock.currentTimeMillis;
        const entry: CachedPlatformRegistration = {
          signature: "wsl:ubuntu",
          registration: {} as never,
          expiresAtEpochMs: issuedAtEpochMs + 3_600_000,
          refreshAtEpochMs: issuedAtEpochMs + 3_600_000 - 5_000,
        };
        yield* Ref.set(cache, new Map([["wsl:ubuntu", entry]]));
        return [entry.registration];
      });
      const stream = platformRegistrationRefreshes({
        changeEvents: Stream.never,
        rebuild,
        nextRefreshAtEpochMs: Effect.map(Ref.get(cache), (entries) =>
          Option.fromNullishOr(earliestRefreshAtEpochMs(entries)),
        ),
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      const firstDeadline = (yield* Effect.map(Ref.get(cache), earliestRefreshAtEpochMs))!;
      const beforeDeadline = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(Duration.millis(firstDeadline - beforeDeadline - 1_000));
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      const atDeadline = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(Duration.millis(firstDeadline - atDeadline));
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(2);

      const rearmedDeadline = (yield* Effect.map(Ref.get(cache), earliestRefreshAtEpochMs))!;
      const afterReissue = yield* Clock.currentTimeMillis;
      yield* TestClock.adjust(Duration.millis(rearmedDeadline - afterReissue));
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(3);

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );

  it.effect("retries an overdue refresh no faster than the old poll cadence", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const cache = yield* Ref.make(
        new Map<string, CachedPlatformRegistration>([
          [
            "wsl:ubuntu",
            {
              signature: "wsl:ubuntu",
              registration: {} as never,
              expiresAtEpochMs: 60_000,
              refreshAtEpochMs: 0,
            },
          ],
        ]),
      );
      const stream = platformRegistrationRefreshes({
        changeEvents: Stream.never,
        rebuild: countingRebuild(rebuilds),
        nextRefreshAtEpochMs: Effect.map(Ref.get(cache), (entries) =>
          Option.fromNullishOr(earliestRefreshAtEpochMs(entries)),
        ),
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      // The overdue deadline is clamped to the retry floor, so no rebuild
      // happens before it elapses.
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(2);

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );

  it.effect("re-runs a failed rebuild after the retry floor without an event", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const rebuildFailed = yield* Ref.make(false);
      const rebuild = Effect.gen(function* () {
        const count = yield* Ref.updateAndGet(rebuilds, (value) => value + 1);
        // Only the first rebuild loses an entry, as a transient load would.
        yield* Ref.set(rebuildFailed, count < 2);
        return [] as ReadonlyArray<never>;
      });
      const stream = platformRegistrationRefreshes({
        changeEvents: Stream.never,
        rebuild,
        nextRefreshAtEpochMs: noRefreshDeadline,
        rebuildFailed: Ref.get(rebuildFailed),
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      // The failure wake is armed at the retry floor, not earlier.
      yield* TestClock.adjust("2 seconds");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      yield* TestClock.adjust("1 second");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(2);

      // The successful rebuild clears the retry wake.
      yield* TestClock.adjust("30 seconds");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(2);
      expect(yield* Ref.get(consumer.received)).toHaveLength(2);

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );

  it.effect("a successful rebuild arms no failure retry", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const stream = platformRegistrationRefreshes({
        changeEvents: Stream.never,
        rebuild: countingRebuild(rebuilds),
        nextRefreshAtEpochMs: noRefreshDeadline,
        rebuildFailed: Effect.succeed(false),
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      yield* TestClock.adjust("30 seconds");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );

  it.effect("backs off consecutive failed rebuilds up to the retry cap", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const stream = platformRegistrationRefreshes({
        changeEvents: Stream.never,
        rebuild: countingRebuild(rebuilds),
        nextRefreshAtEpochMs: noRefreshDeadline,
        rebuildFailed: Effect.succeed(true),
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(1);

      // 3s, 6s, 12s, 24s, then capped at 30s: the final two 30-second steps
      // would miss a still-doubling backoff (48s, 60s).
      const cadence = [
        "3 seconds",
        "6 seconds",
        "12 seconds",
        "24 seconds",
        "30 seconds",
        "30 seconds",
      ] as const;
      for (const [index, step] of cadence.entries()) {
        yield* TestClock.adjust(step);
        yield* settle;
        expect(yield* Ref.get(rebuilds)).toBe(index + 2);
      }

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );

  it.effect("keeps the 3-second tick when the bridge lacks the change event", () =>
    Effect.gen(function* () {
      const rebuilds = yield* Ref.make(0);
      const stream = platformRegistrationRefreshes({
        rebuild: countingRebuild(rebuilds),
        nextRefreshAtEpochMs: noRefreshDeadline,
      });
      const consumer = yield* runCollecting(stream);
      yield* settle;
      // The tick's own semantics: build immediately, then once per interval.
      expect(yield* Ref.get(rebuilds)).toBe(1);

      yield* TestClock.adjust("3 seconds");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(2);

      yield* TestClock.adjust("3 seconds");
      yield* settle;
      expect(yield* Ref.get(rebuilds)).toBe(3);

      yield* Fiber.interrupt(consumer.fiber);
    }),
  );
});
