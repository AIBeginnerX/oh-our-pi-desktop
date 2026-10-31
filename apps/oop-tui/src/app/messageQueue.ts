import type { ThreadId } from "@t3tools/contracts";

/** Why the queue of a thread does not send by itself. */
export type QueueHold = "error" | "failed" | "left";

/** What the thread looked like when a turn start went out: the server's turn state, and the turn it showed last. */
export interface TurnMark {
  readonly key: string;
  readonly turnId: string | null;
  /** When it went out (epoch ms): a turn that never shows is not waited for for ever. */
  readonly at: number;
}

interface Entry {
  readonly items: string[];
  held: QueueHold | null;
  /**
   * What the thread looked like when the last turn start went out. The next message waits until the
   * server shows that turn: one that was just requested still reads as idle for a moment.
   */
  awaiting: TurnMark | null;
}

/**
 * Messages typed while a turn runs, kept per thread so none can reach another thread. They live
 * in this process only, as the desktop's queue lives in its window: a queued message is an intent
 * of the moment, not a draft to keep.
 */
export class MessageQueue {
  private readonly entries = new Map<ThreadId, Entry>();

  private entry(threadId: ThreadId): Entry {
    let entry = this.entries.get(threadId);
    if (entry === undefined) {
      entry = { items: [], held: null, awaiting: null };
      this.entries.set(threadId, entry);
    }
    return entry;
  }

  items(threadId: ThreadId): ReadonlyArray<string> {
    return this.entries.get(threadId)?.items ?? [];
  }

  held(threadId: ThreadId): QueueHold | null {
    return this.entries.get(threadId)?.held ?? null;
  }

  awaiting(threadId: ThreadId): TurnMark | null {
    return this.entries.get(threadId)?.awaiting ?? null;
  }

  push(threadId: ThreadId, text: string): void {
    this.entry(threadId).items.push(text);
  }

  /** The message that goes next leaves the queue; the caller puts it back with `restore` if it did not go. */
  next(threadId: ThreadId, awaiting: TurnMark): string | undefined {
    const entry = this.entries.get(threadId);
    const text = entry?.items.shift();
    if (entry !== undefined && text !== undefined) entry.awaiting = awaiting;
    return text;
  }

  /** A message that was not sent returns to the head, and the queue stops until the user lets it go on. */
  restore(threadId: ThreadId, text: string, hold: QueueHold): void {
    const entry = this.entry(threadId);
    entry.items.unshift(text);
    entry.held = hold;
    entry.awaiting = null;
  }

  /** The newest message, for the user to edit or drop. */
  takeLast(threadId: ThreadId): string | undefined {
    return this.entries.get(threadId)?.items.pop();
  }

  /** Every message, oldest first, leaving the queue empty. */
  takeAll(threadId: ThreadId): string[] {
    const entry = this.entries.get(threadId);
    if (entry === undefined) return [];
    entry.held = null;
    entry.awaiting = null;
    return entry.items.splice(0);
  }

  hold(threadId: ThreadId, reason: QueueHold): void {
    const entry = this.entries.get(threadId);
    if (entry !== undefined && entry.items.length > 0 && entry.held === null) entry.held = reason;
  }

  /** Leaving a thread stops every queue: nothing is sent where the user is not looking. */
  holdAll(): void {
    for (const threadId of this.entries.keys()) this.hold(threadId, "left");
  }

  release(threadId: ThreadId): void {
    const entry = this.entries.get(threadId);
    if (entry !== undefined) entry.held = null;
  }

  drop(threadId: ThreadId): void {
    this.entries.delete(threadId);
  }
}
