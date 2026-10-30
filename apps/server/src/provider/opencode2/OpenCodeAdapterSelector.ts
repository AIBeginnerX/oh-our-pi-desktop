/**
 * Routes each OpenCode thread to the adapter for the protocol the installed
 * OpenCode speaks. A thread stays with the adapter that started it, so an
 * OpenCode upgrade takes effect on the next session start.
 *
 * @module provider/opencode2/OpenCodeAdapterSelector
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ProviderAdapterValidationError } from "../Errors.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";

export function selectOpenCodeAdapter(input: {
  readonly v1: OpenCodeAdapterShape;
  readonly v2: OpenCodeAdapterShape;
  readonly isV2: Effect.Effect<boolean>;
}): OpenCodeAdapterShape {
  const { v1, v2 } = input;
  const owners = new Map<ThreadId, OpenCodeAdapterShape>();
  const ownerOf = (threadId: ThreadId) => owners.get(threadId) ?? v1;
  const v1Compaction = v1.compaction;

  return {
    provider: v1.provider,
    capabilities: v1.capabilities,
    startSession: (session) =>
      Effect.gen(function* () {
        const adapter = (yield* input.isV2) ? v2 : v1;
        const previous = owners.get(session.threadId);
        if (previous !== undefined && previous !== adapter) {
          yield* previous.stopSession(session.threadId).pipe(Effect.ignore);
          owners.delete(session.threadId);
        }
        const started = yield* adapter.startSession(session);
        owners.set(session.threadId, adapter);
        return started;
      }),
    sendTurn: (turn, admission) => ownerOf(turn.threadId).sendTurn(turn, admission),
    ...(v1Compaction?.type === "native"
      ? {
          compaction: {
            type: "native" as const,
            start: (
              threadId: ThreadId,
              modelSelection?: Parameters<typeof v1Compaction.start>[1],
            ) =>
              ownerOf(threadId) === v1
                ? v1Compaction.start(threadId, modelSelection)
                : Effect.fail(
                    new ProviderAdapterValidationError({
                      provider: v1.provider,
                      operation: "compactThread",
                      issue: "Manual compaction is not available for OpenCode 2 sessions yet.",
                    }),
                  ),
          },
        }
      : v1Compaction !== undefined
        ? { compaction: v1Compaction }
        : {}),
    interruptTurn: (threadId, turnId) => ownerOf(threadId).interruptTurn(threadId, turnId),
    respondToRequest: (threadId, requestId, decision) =>
      ownerOf(threadId).respondToRequest(threadId, requestId, decision),
    respondToUserInput: (threadId, requestId, answers) =>
      ownerOf(threadId).respondToUserInput(threadId, requestId, answers),
    stopSession: (threadId) =>
      ownerOf(threadId)
        .stopSession(threadId)
        .pipe(Effect.ensuring(Effect.sync(() => owners.delete(threadId)))),
    listSessions: () =>
      Effect.all([v1.listSessions(), v2.listSessions()]).pipe(
        Effect.map(([left, right]) => [...left, ...right]),
      ),
    hasSession: (threadId) => ownerOf(threadId).hasSession(threadId),
    readThread: (threadId) => ownerOf(threadId).readThread(threadId),
    rollbackThread: (threadId, numTurns) => ownerOf(threadId).rollbackThread(threadId, numTurns),
    stopAll: () =>
      Effect.all([v1.stopAll(), v2.stopAll()], { discard: true }).pipe(
        Effect.ensuring(Effect.sync(() => owners.clear())),
      ),
    get streamEvents() {
      return Stream.merge(v1.streamEvents, v2.streamEvents);
    },
  };
}
