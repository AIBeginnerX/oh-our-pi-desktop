import type { OrchestrationThread, OrchestrationThreadStreamItem } from "@t3tools/contracts";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/thread-reducer";

export interface ThreadMirrorState {
  readonly thread: OrchestrationThread | null;
  /** Highest event sequence applied; a resumed subscription asks for everything after it. */
  readonly sequence: number | null;
  /** The server finished replaying history; later items are live. */
  readonly synchronized: boolean;
  readonly deleted: boolean;
  /** A windowed load left older turns on the server. */
  readonly hasOlder: boolean;
  /** Where the older turns start: handed back to the server to read the page before the window. */
  readonly olderCursor: string | null;
}

export const emptyThreadMirror: ThreadMirrorState = {
  thread: null,
  sequence: null,
  synchronized: false,
  deleted: false,
  hasOlder: false,
  olderCursor: null,
};

/** Folds one stream item into the mirror, dropping events the snapshot already contains. */
export const applyThreadItem = (
  state: ThreadMirrorState,
  item: OrchestrationThreadStreamItem,
): ThreadMirrorState => {
  if (item.kind === "synchronized") return { ...state, synchronized: true };
  if (item.kind === "snapshot") {
    return {
      thread: item.snapshot.thread,
      sequence: item.snapshot.snapshotSequence,
      synchronized: state.synchronized,
      deleted: false,
      hasOlder: item.snapshot.page?.hasMore === true,
      olderCursor: item.snapshot.page?.beforeCursor ?? null,
    };
  }
  const { event } = item;
  if (state.sequence !== null && event.sequence <= state.sequence) return state;
  if (state.thread === null) {
    return event.type === "thread.deleted"
      ? { ...state, sequence: event.sequence, deleted: true }
      : { ...state, sequence: event.sequence };
  }
  const result = applyThreadDetailEvent(state.thread, event);
  if (result.kind === "deleted") return { ...state, sequence: event.sequence, deleted: true };
  if (result.kind === "unchanged") return { ...state, sequence: event.sequence };
  return { ...state, thread: result.thread, sequence: event.sequence };
};
