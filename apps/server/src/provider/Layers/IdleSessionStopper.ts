import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { reapBlock, type ReapBlock } from "../sessionCapacity.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../Services/ProviderService.ts";

export interface IdleInspection {
  readonly binding: ProviderRuntimeBindingWithMetadata;
  readonly block: ReapBlock | null;
  readonly idleMs: number;
  readonly activeTurnId?: string | null | undefined;
  readonly backgroundLiveness?: string | null | undefined;
}

/**
 * The safety checks and stop path shared by the idle reaper and pressure reaping, so both leave
 * a session with an active turn or background work alone.
 */
export const makeIdleSessionStopper = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const inspect = (
    binding: ProviderRuntimeBindingWithMetadata,
    now: number,
    minIdleMs: number,
  ): Effect.Effect<IdleInspection> =>
    Effect.gen(function* () {
      // Cheap check first: most live sessions are recent and need no thread lookup.
      const early = reapBlock({ lastSeenAt: binding.lastSeenAt, now, minIdleMs });
      if (early.block !== null) return { binding, ...early };
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(binding.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      const full = reapBlock({
        lastSeenAt: binding.lastSeenAt,
        sessionUpdatedAt: thread?.session?.updatedAt,
        activeTurnId: thread?.session?.activeTurnId,
        backgroundLiveness: thread?.backgroundLiveness,
        now,
        minIdleMs,
      });
      return {
        binding,
        ...full,
        activeTurnId: thread?.session?.activeTurnId,
        backgroundLiveness: thread?.backgroundLiveness,
      };
    }).pipe(
      // A failed lookup must never make a session look safe to stop.
      Effect.catchCause(() =>
        Effect.succeed({ binding, block: "active-turn", idleMs: 0 } as const),
      ),
    );

  const stop = (
    threadId: ThreadId,
    binding: ProviderRuntimeBindingWithMetadata,
    idleMs: number,
    reason: string,
  ) =>
    providerService.stopSession({ threadId }).pipe(
      Effect.tap(() =>
        Effect.logInfo("provider.session.reaped", {
          threadId,
          provider: binding.provider,
          idleDurationMs: idleMs,
          reason,
        }),
      ),
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logWarning("provider.session.reaper.stop-failed", {
          threadId,
          provider: binding.provider,
          idleDurationMs: idleMs,
          cause,
        }).pipe(Effect.as(false)),
      ),
    );

  return { inspect, stop };
});
