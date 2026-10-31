import type {
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";

/** Messages `/history` prints when no number is given. */
export const HISTORY_DEFAULT = 30;
/** Most messages one `/history` prints; a bigger ask is cut to this, not refused. */
export const HISTORY_MAX = 200;

/**
 * The older part of the thread on screen that was never printed: what the opening window loaded but
 * skipped, plus the pages fetched since. It is read back from the newest end, so each `/history`
 * continues where the last one stopped. Messages, activities and plans are all oldest first. A
 * plan is written where it was proposed, so only the plans older than the printed part are here;
 * the others are on screen already.
 */
export interface HistoryPool {
  readonly messages: OrchestrationMessage[];
  readonly activities: OrchestrationThreadActivity[];
  readonly plans: OrchestrationProposedPlan[];
  /** Where the next page of older turns starts; null when the server has nothing older. */
  cursor: string | null;
}

const visibleMessages = (messages: ReadonlyArray<OrchestrationMessage>): OrchestrationMessage[] =>
  messages.filter((message) => message.role !== "reasoning");

/**
 * The pool of a thread whose opening printed all but the first `skipped` visible messages.
 * `cursor` is what the server gave for the turns before the window, when it left any.
 */
export const openHistoryPool = (
  thread: OrchestrationThread,
  skipped: number,
  cursor: string | null,
): HistoryPool => {
  const visible = visibleMessages(thread.messages);
  const floor = visible[skipped]?.createdAt ?? null;
  return {
    messages: visible.slice(0, skipped),
    activities:
      floor === null ? [] : thread.activities.filter((activity) => activity.createdAt < floor),
    plans: floor === null ? [] : thread.proposedPlans.filter((plan) => plan.createdAt < floor),
    cursor,
  };
};

/** Whether there is anything older left to print, here or on the server. */
export const historyLeft = (pool: HistoryPool): boolean =>
  pool.messages.length > 0 || pool.cursor !== null;

/**
 * Puts a page of older turns in front of the pool. A page also carries every plan of the thread,
 * the ones already on screen included, so its plans are left out: the pool took the older ones from
 * the opening snapshot, which has them all.
 */
export const addHistoryPage = (
  pool: HistoryPool,
  page: OrchestrationThreadDetailSnapshot,
): void => {
  const known = new Set(pool.messages.map((message) => message.id));
  const fresh = visibleMessages(page.thread.messages).filter((message) => !known.has(message.id));
  const knownActivities = new Set(pool.activities.map((activity) => activity.id));
  const freshActivities = page.thread.activities.filter(
    (activity) => !knownActivities.has(activity.id),
  );
  pool.messages.unshift(...fresh);
  pool.activities.unshift(...freshActivities);
  const next = page.page?.hasMore === true ? page.page.beforeCursor : null;
  // A server that answers with the cursor it was given would be asked for ever.
  pool.cursor = next === pool.cursor || fresh.length === 0 ? null : next;
};

export interface HistoryBatch {
  readonly messages: OrchestrationMessage[];
  readonly activities: OrchestrationThreadActivity[];
  readonly plans: OrchestrationProposedPlan[];
}

/**
 * Takes the newest `count` messages from the pool, with the activities (tool results and the like)
 * and plans between them and what was printed before. Taking the oldest ones takes everything before
 * them.
 */
export const takeHistoryBatch = (pool: HistoryPool, count: number): HistoryBatch => {
  const messages = pool.messages.splice(Math.max(0, pool.messages.length - count));
  const start = pool.messages.length === 0 && pool.cursor === null ? "" : messages[0]?.createdAt;
  if (start === undefined) return { messages, activities: [], plans: [] };
  const split = <T extends { readonly createdAt: string }>(rows: T[]): T[] => {
    const taken = rows.filter((row) => row.createdAt >= start);
    const kept = rows.filter((row) => row.createdAt < start);
    rows.length = 0;
    rows.push(...kept);
    return taken;
  };
  return { messages, activities: split(pool.activities), plans: split(pool.plans) };
};

/** The count in `/history <n>`: whole numbers from 1, cut to the most one command prints; null for anything else. */
export const parseHistoryCount = (word: string | undefined): number | null => {
  if (word === undefined) return HISTORY_DEFAULT;
  if (!/^\d+$/u.test(word)) return null;
  const count = Number(word);
  return count >= 1 ? Math.min(count, HISTORY_MAX) : null;
};
