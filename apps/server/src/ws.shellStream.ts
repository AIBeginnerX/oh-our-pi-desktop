import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationShellStreamItem,
} from "@t3tools/contracts";

import type * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

// Activity kinds that never touch a shell field other than `updatedAt`. Plan
// progress and background liveness ride on `turn.plan.updated` and `task.*`,
// approvals and user input on their own kinds, so those are deliberately absent.
export const SHELL_INERT_ACTIVITY_KINDS: ReadonlySet<string> = new Set([
  "tool.started",
  "tool.updated",
  "tool.progress",
  "tool.completed",
  "context-window.updated",
]);

// A streaming assistant delta or a tool activity only bumps the thread's
// `updatedAt`. Pushing a full shell for each (per subscriber, every
// coalescing window) is pure overhead: the turn start/end, the finished
// message, and every other event still push the current `updatedAt`. One
// still gets through per thread every SHELL_INERT_REFRESH_MS, so the shell's
// `updatedAt` shows clients that a long tool-only stretch is still working
// (the web no-activity alert reads it).
export const isShellInertEvent = (event: OrchestrationEvent): boolean => {
  switch (event.type) {
    case "thread.message-sent":
      return event.payload?.role === "assistant" && event.payload.streaming === true;
    case "thread.activity-appended":
      return SHELL_INERT_ACTIVITY_KINDS.has(event.payload?.activity?.kind);
    default:
      return false;
  }
};

// Shell updates refetch the aggregate. Message and tool bodies are not needed.
export const toShellEvent = (event: OrchestrationEvent) => ({
  type: event.type,
  aggregateKind: event.aggregateKind,
  aggregateId: event.aggregateId,
  sequence: event.sequence,
  inert: isShellInertEvent(event),
});
export type ShellEvent = ReturnType<typeof toShellEvent>;

// Coalescing makes each projection read represent every event for that
// aggregate in the current window. Retry a typed persistence failure once
// so a brief read failure cannot strand the shell at its previous state.
// If both attempts fail, log and drop the stream item; treating an error as
// a missing row would incorrectly remove a still-active aggregate.
export const retryShellProjectionRead = <A, E>(
  aggregateKind: "project" | "thread",
  aggregateId: string,
  read: Effect.Effect<A, E>,
): Effect.Effect<Option.Option<A>, never, never> =>
  read.pipe(
    Effect.retry({ times: 1 }),
    Effect.asSome,
    Effect.tapError((error) =>
      Effect.logWarning("orchestration shell projection refetch failed", {
        aggregateKind,
        aggregateId,
        error,
      }),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );

// Small time/size window over which to coalesce shell events. The window
// bounds the worst-case added latency for a brand-new thread to appear in
// the sidebar (imperceptible), while collapsing high-frequency streaming
// traffic so it can't serialize the shell stream behind per-event DB reads.
export const SHELL_COALESCE_WINDOW = Duration.millis(50);
export const SHELL_COALESCE_MAX_CHUNK = 512;
export const SHELL_INERT_REFRESH_MS = 30_000;

export type ShellLiveInput =
  | { readonly kind: "event"; readonly event: ShellEvent }
  | { readonly kind: "synchronized" };

export const makeShellStreamCoalescers = (
  projectionSnapshotQuery: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"],
) => {
  const toShellStreamEvent = (
    event: ShellEvent,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> => {
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
        return projectUpsertOrRemove(ProjectId.make(event.aggregateId), event.sequence);
      case "project.deleted":
        return Effect.succeedSome({
          kind: "project-removed" as const,
          sequence: event.sequence,
          projectId: ProjectId.make(event.aggregateId),
        });
      case "thread.deleted":
      case "thread.archived":
        return Effect.succeedSome({
          kind: "thread-removed" as const,
          sequence: event.sequence,
          threadId: ThreadId.make(event.aggregateId),
        });
      case "thread.unarchived":
        return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
      default:
        if (event.aggregateKind !== "thread") {
          return Effect.succeedNone;
        }
        return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
    }
  };

  const projectUpsertOrRemove = (
    projectId: ProjectId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead(
      "project",
      projectId,
      projectionSnapshotQuery.getProjectShellById(projectId),
    ).pipe(
      Effect.map(
        Option.flatMap((project) =>
          Option.match(project, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "project-removed" as const,
                sequence,
                projectId,
              }),
            onSome: (nextProject) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "project-upserted" as const,
                sequence,
                project: nextProject,
              }),
          }),
        ),
      ),
    );

  // Refetch a thread's shell and emit an upsert if it is still active, or a
  // `thread-removed` if the projection has no active row for it. Emitting a
  // removal on a `none` (rather than dropping the event) is what keeps
  // coalescing correct: when a burst collapses a `thread.deleted`/`archived`
  // into a later refetchable event for the same thread, the refetch returns
  // `none` for the now-inactive row and this still tells the sidebar to drop
  // it. A `thread-removed` the client does not have is a harmless no-op. The
  // projection commits in the same transaction before the event publishes,
  // so a `none` reliably means the thread is deleted or archived, not
  // not-yet-persisted.
  const threadUpsertOrRemove = (
    threadId: ThreadId,
    sequence: number,
  ): Effect.Effect<Option.Option<OrchestrationShellStreamEvent>, never, never> =>
    retryShellProjectionRead(
      "thread",
      threadId,
      projectionSnapshotQuery.getThreadShellById(threadId),
    ).pipe(
      Effect.map(
        Option.flatMap((thread) =>
          Option.match(thread, {
            onNone: () =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "thread-removed" as const,
                sequence,
                threadId,
              }),
            onSome: (nextThread) =>
              Option.some<OrchestrationShellStreamEvent>({
                kind: "thread-upserted" as const,
                sequence,
                thread: nextThread,
              }),
          }),
        ),
      ),
    );

  // Turn a batch of domain events into shell stream items, coalescing by
  // aggregate first. `toShellStreamEvent` re-reads the *current* projected
  // shell for an aggregate, so within a batch only the latest event per
  // aggregate matters: a burst of streaming `thread.message-sent` deltas for
  // one thread collapses into a single shell refetch, and an unrelated
  // `thread.created` in the same batch is never stuck behind those DB reads.
  //
  // Input events arrive in ascending sequence; we keep the last (highest
  // sequence) event per aggregate, then re-sort ascending before emitting so
  // the client — which applies shell items strictly by increasing sequence
  // and drops any `sequence <= snapshotSequence` — never skips a coalesced
  // item. The refetch runs with bounded concurrency (order-preserving).
  const SHELL_REFETCH_CONCURRENCY = 8;
  // When this subscriber last got (or, for inert-only threads, first saw) each
  // aggregate, in clock millis. Bounded by the threads seen on this stream.
  const lastPushedAt = new Map<string, number>();
  const coalesceShellEvents = (
    events: ReadonlyArray<ShellEvent>,
  ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamEvent>, never, never> =>
    Effect.gen(function* () {
      if (events.length === 0) {
        return [];
      }
      const now = yield* Clock.currentTimeMillis;
      const latestByAggregate = new Map<string, ShellEvent>();
      // Inert events must not displace an earlier real change in the same
      // window: the refetch they would trigger is only needed if something
      // else did not already trigger it.
      for (const event of events) {
        const key = `${event.aggregateKind}:${event.aggregateId}`;
        if (event.inert) {
          const last = lastPushedAt.get(key);
          if (last === undefined) lastPushedAt.set(key, now);
          if (last === undefined || latestByAggregate.has(key)) continue;
          if (now - last < SHELL_INERT_REFRESH_MS) continue;
        }
        latestByAggregate.set(key, event);
      }
      for (const key of latestByAggregate.keys()) lastPushedAt.set(key, now);
      const survivors = Array.from(latestByAggregate.values()).sort(
        (left, right) => left.sequence - right.sequence,
      );
      const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
        concurrency: SHELL_REFETCH_CONCURRENCY,
      });
      return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
    });

  const coalesceShellStream = <E, R>(
    stream: Stream.Stream<OrchestrationEvent, E, R>,
  ): Stream.Stream<OrchestrationShellStreamEvent, E, R> =>
    stream.pipe(
      Stream.map(toShellEvent),
      Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
      Stream.mapEffect(coalesceShellEvents),
      Stream.flatMap((items) => Stream.fromIterable(items)),
    );

  // A completion marker is queued alongside live event metadata so it cannot
  // overtake an event still waiting in the coalescing window. Split each
  // batch at markers and coalesce only the event segments on either side.
  const coalesceShellLiveInputs = (
    inputs: ReadonlyArray<ShellLiveInput>,
  ): Effect.Effect<ReadonlyArray<OrchestrationShellStreamItem>, never, never> =>
    Effect.gen(function* () {
      const output: Array<OrchestrationShellStreamItem> = [];
      let pendingEvents: Array<ShellEvent> = [];

      for (const input of inputs) {
        if (input.kind === "event") {
          pendingEvents.push(input.event);
          continue;
        }

        output.push(...(yield* coalesceShellEvents(pendingEvents)));
        pendingEvents = [];
        output.push({ kind: "synchronized" });
      }

      output.push(...(yield* coalesceShellEvents(pendingEvents)));
      return output;
    });

  return { coalesceShellStream, coalesceShellLiveInputs };
};
