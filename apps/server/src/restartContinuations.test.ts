import { describe, expect, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer, RestartContinuations } from "./restartContinuations.ts";

const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const instanceId = ProviderInstanceId.make("instance-1");
const turnId = TurnId.make("turn-1");
const commandId = CommandId.make("cmd-1");

describe("restartContinuations", () => {
  it.effect("reserve revokes the previous token and installs a fresh replacement", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const first = continuations.reserve(threadId, instanceId);
      first.seen.add(turnId);
      const second = continuations.reserve(threadId, instanceId);

      expect(first.revoked).toBe(true);
      expect(continuations.current(threadId)).toBe(second);
      expect(second.revoked).toBe(false);
      expect(second.seen).not.toBe(first.seen);
      expect(second.seen.size).toBe(0);
      expect(second.evidence).toBeUndefined();
      expect(continuations.isLive(first)).toBe(false);
      expect(continuations.isLive(second)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a replaced token cannot touch its replacement through record or retire", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const first = continuations.reserve(threadId, instanceId);
      const second = continuations.reserve(threadId, instanceId);

      continuations.record(first, { kind: "returned", turnId });
      continuations.retire(first);

      expect(second.evidence).toBeUndefined();
      expect(continuations.current(threadId)).toBe(second);
      expect(continuations.isLive(second)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("isLive turns false when any of revoked, canceled, or deleted is set", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      for (const flag of ["revoked", "canceled", "deleted"] as const) {
        const token = continuations.reserve(threadId, instanceId);
        expect(continuations.isLive(token)).toBe(true);
        token[flag] = true;
        expect(continuations.isLive(token)).toBe(false);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("isLive requires exact current identity, not just a matching thread", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);

      expect(continuations.isLive({ ...token })).toBe(false);

      continuations.reserve(threadId, instanceId);
      expect(continuations.isLive(token)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("revokeAnyHeld revokes an unfinished token and reports wasUnfinished", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);

      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: true });
      expect(token.revoked).toBe(true);
      expect(continuations.isLive(token)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("revokeAnyHeld still revokes after returned evidence and reports finished", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);
      continuations.record(token, { kind: "returned", turnId });

      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: false });
      expect(token.revoked).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("revokeAnyHeld with no token reports not unfinished", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;

      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: false });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("wasUnfinished ignores canceled flags and stays true across repeated revocation", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);
      token.canceled = true;

      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: true });
      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: true });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("held evidence still counts as unfinished for the interrupt-to-stop promotion", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);
      continuations.record(token, { kind: "held", commandId });

      expect(token.evidence).toEqual({ kind: "held", commandId });
      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: true });
      expect(token.revoked).toBe(true);
      // A held token that went terminal still means "never reached provider
      // entry", so the promotion keeps applying on repeated revocation.
      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: true });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("terminal evidence kinds other than held report finished", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      for (const evidence of [
        { kind: "returned", turnId },
        { kind: "revoked" },
        { kind: "unverified" },
      ] as const) {
        const token = continuations.reserve(threadId, instanceId);
        continuations.record(token, evidence);

        expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: false });
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("held evidence keeps the first-write-wins rule", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);

      continuations.record(token, { kind: "held", commandId });
      continuations.record(token, { kind: "returned", turnId });

      expect(token.evidence).toEqual({ kind: "held", commandId });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("record keeps only the first evidence", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);

      continuations.record(token, { kind: "returned", turnId });
      continuations.record(token, { kind: "revoked" });
      continuations.record(token, { kind: "unverified" });

      expect(token.evidence).toEqual({ kind: "returned", turnId });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("recording evidence on a revoked token does not revive it", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.reserve(threadId, instanceId);
      token.revoked = true;

      continuations.record(token, { kind: "returned", turnId });

      expect(token.evidence).toEqual({ kind: "returned", turnId });
      expect(continuations.isLive(token)).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("tokens are isolated across threads", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const first = continuations.reserve(threadId, instanceId);
      const second = continuations.reserve(otherThreadId, instanceId);

      expect(continuations.current(otherThreadId)).toBe(second);
      expect(continuations.revokeAnyHeld(threadId)).toEqual({ wasUnfinished: true });

      expect(first.revoked).toBe(true);
      expect(second.revoked).toBe(false);
      expect(continuations.isLive(second)).toBe(true);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("one layer value provided to two dependent layers builds one instance", () =>
    Effect.gen(function* () {
      const continuations = yield* RestartContinuations;
      const token = continuations.current(threadId);

      expect(token?.threadId).toBe(threadId);
      expect(token?.providerInstanceId).toBe(instanceId);
      expect(token?.evidence).toEqual({ kind: "returned", turnId });
      if (token !== undefined) {
        expect(continuations.isLive(token)).toBe(true);
      }
    }).pipe(
      Effect.provide(
        Layer.provideMerge(
          Layer.effectDiscard(
            Effect.gen(function* () {
              const continuations = yield* RestartContinuations;
              const token = continuations.current(threadId);
              if (token !== undefined) {
                continuations.record(token, { kind: "returned", turnId });
              }
            }),
          ),
          Layer.provideMerge(
            Layer.effectDiscard(
              Effect.gen(function* () {
                const continuations = yield* RestartContinuations;
                continuations.reserve(threadId, instanceId);
              }),
            ),
            layer,
          ),
        ),
      ),
    ),
  );

  it.effect("separate layer builds do not share state", () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const continuations = yield* RestartContinuations;
        continuations.reserve(threadId, instanceId);
      }).pipe(Effect.provide(layer));

      const current = yield* Effect.gen(function* () {
        const continuations = yield* RestartContinuations;
        return continuations.current(threadId);
      }).pipe(Effect.provide(layer));

      expect(current).toBeUndefined();
    }),
  );
});
