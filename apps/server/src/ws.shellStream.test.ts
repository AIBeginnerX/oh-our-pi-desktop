import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import type * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  makeShellStreamCoalescers,
  SHELL_INERT_REFRESH_MS,
  toShellEvent,
} from "./ws.shellStream.ts";

const threadId = ThreadId.make("thread-busy");

// A tool activity (inert: it only bumps `updatedAt`) or a session change (a real shell change).
const event = (sequence: number, inert: boolean) =>
  ({
    sequence,
    aggregateKind: "thread",
    aggregateId: threadId,
    type: inert ? "thread.activity-appended" : "thread.session-set",
    payload: inert ? { activity: { kind: "tool.updated" } } : {},
  }) as unknown as OrchestrationEvent;

it.effect("refreshes a thread's shell for inert activity at most once per interval", () =>
  Effect.gen(function* () {
    const { coalesceShellLiveInputs } = makeShellStreamCoalescers({
      getThreadShellById: (id: ThreadId) =>
        Effect.succeedSome({ id } as unknown as OrchestrationThreadShell),
    } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]);
    const pushed = (sequence: number, inert: boolean) =>
      coalesceShellLiveInputs([
        { kind: "event", event: toShellEvent(event(sequence, inert)) },
      ]).pipe(
        Effect.map((items) =>
          items.flatMap((item) => (item.kind === "thread-upserted" ? [item.sequence] : [])),
        ),
      );

    // The first inert event only starts the interval: the snapshot already carried updatedAt.
    assert.deepEqual(yield* pushed(1, true), []);
    yield* TestClock.adjust(SHELL_INERT_REFRESH_MS - 1);
    assert.deepEqual(yield* pushed(2, true), []);
    yield* TestClock.adjust(1);
    assert.deepEqual(yield* pushed(3, true), [3]);
    assert.deepEqual(yield* pushed(4, true), []);

    // A real change pushes at once and restarts the interval.
    yield* TestClock.adjust(SHELL_INERT_REFRESH_MS / 2);
    assert.deepEqual(yield* pushed(5, false), [5]);
    yield* TestClock.adjust(SHELL_INERT_REFRESH_MS - 1);
    assert.deepEqual(yield* pushed(6, true), []);
    yield* TestClock.adjust(1);
    assert.deepEqual(yield* pushed(7, true), [7]);
  }),
);
