# Event store retention

`orchestration_events` is the source of truth, and several readers replay it long after the
projections are built: catch-up subscriptions, projector rebuilds, usage ownership, work
digests, and project skill trials. Background compaction
(`apps/server/src/persistence/EventStoreCompaction.ts`) deletes only events that every one of
those readers ignores. Before adding a pruning rule, check these constraints:

- **Prune behind the projector cursors.** An event after
  `MIN(projection_state.last_applied_sequence)` may still be applied, so deleting it silently
  drops projected state. Receipt pruning uses the same floor.
- **A rebuild must reproduce the visible state.** Deleting an event is safe only when a kept
  event supersedes what it projected. "Later" means the read path's activity order (the
  activity's own `sequence`, rows without one first, then `createdAt`, then id), not event
  order. Tool and context-window activities carry no `sequence` today, so `createdAt`
  decides, and it can disagree with event order. Delete the projection rows of pruned events
  too, so the live tables match what a rebuild produces.
- **Streaming message deltas are the message text.** The final non-streaming
  `thread.message-sent` event carries empty text; the projector concatenates the deltas.
- **Deleted threads keep their history.** Deletion is soft and an id can be recreated, and
  project skill trials read a thread's `thread.created`/`thread.deleted` boundaries and its
  activities after the thread is gone.
- **Every query blocks the server.** node:sqlite is synchronous, so maintenance reads bounded
  windows, deletes in bounded batches, and yields to the event loop between statements.
  One unbounded scan of a large database stalls every connected client.
