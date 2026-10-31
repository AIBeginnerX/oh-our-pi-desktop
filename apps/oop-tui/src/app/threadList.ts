import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import {
  pinOrderKeyBetween,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";

import { crewSubThreadLabel, listedThreads, type ListedThreads } from "./crewBoard.ts";
import { filterRanked, searchField } from "./listSearch.ts";

export const isPinned = (thread: OrchestrationThreadShell): boolean => thread.pinnedAt != null;

/** How a thread is named on its row: a crew thread that waits for the user is shown as its task. */
export const threadRowLabel = (thread: OrchestrationThreadShell, listed: ListedThreads): string =>
  listed.waiting.has(thread.id) ? `crew ${crewSubThreadLabel(thread.title)}` : thread.title;

export interface ThreadRows {
  /** The rows to draw, in order: crew threads that wait for the user, pinned threads, then the rest. */
  readonly rows: ReadonlyArray<OrchestrationThreadShell>;
  readonly listed: ListedThreads;
}

/**
 * The threads `/threads` lists for a project, narrowed by the typed words. Pinned threads follow
 * the crew threads that wait for an answer, in the order the desktop app's pinned block has; the
 * rest keep the newest-first order. With words typed, the best title match comes first and a tie
 * keeps that order.
 */
export const threadRows = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projectId: string,
  query: string,
): ThreadRows => {
  const listed = listedThreads(threads, projectId);
  const waiting = listed.rows.filter((thread) => listed.waiting.has(thread.id));
  const others = listed.rows.filter((thread) => !listed.waiting.has(thread.id));
  const ordered = [
    ...waiting,
    ...sortPinnedThreadsByOrderKey(others.filter(isPinned)),
    ...others.filter((thread) => !isPinned(thread)),
  ];
  return {
    rows: filterRanked(ordered, query, (thread) => [searchField(threadRowLabel(thread, listed))]),
    listed,
  };
};

/** The projects whose title or folder matches the typed words. */
export const filterProjects = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  query: string,
): ReadonlyArray<OrchestrationProjectShell> =>
  filterRanked(projects, query, (project) => [
    searchField(project.title),
    searchField(project.workspaceRoot),
  ]);

/**
 * The order key a new pin takes, as the desktop app does: ahead of every key already in use, so the
 * thread lands at the top of the pinned block. Undefined when no key can be made; the server then
 * pins it keyless, which sorts after the arranged ones.
 */
export const topPinOrderKey = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): string | undefined => {
  let first: string | null = null;
  for (const thread of threads) {
    if (thread.pinnedAt == null || thread.pinOrderKey == null) continue;
    if (first === null || thread.pinOrderKey < first) first = thread.pinOrderKey;
  }
  return pinOrderKeyBetween(null, first) ?? undefined;
};
