import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import {
  effectiveSnoozed,
  snoozeWakeLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";

import { crewSubThreadLabel, isCrewSubThread } from "./crewBoard.ts";
import type { NavItem, NavSection, NavStatus } from "../render/navPane.ts";

/** The settled shelf shows this many rows when opened, and this many more each time it is asked. */
export const SETTLED_INITIAL = 10;
export const SETTLED_PAGE = 25;

/** What the reader changed in the list: which shelves are open and how much of the settled one. */
export interface SidebarView {
  readonly snoozedOpen: boolean;
  readonly settledOpen: boolean;
  readonly settledShown: number;
}

export const INITIAL_SIDEBAR_VIEW: SidebarView = {
  snoozedOpen: false,
  settledOpen: false,
  settledShown: SETTLED_INITIAL,
};

const MINUTE = 60_000;

/**
 * The desktop sidebar's compact age: `now` under a minute, then `5m`, `3h`, `2d` (the same cut-offs
 * as the web app's `formatRelativeTime`, with the `ago` dropped). Empty for an unreadable stamp.
 */
export const compactAge = (iso: string | null | undefined, nowMs: number): string => {
  if (iso == null) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const minutes = Math.floor(Math.max(0, nowMs - then) / MINUTE);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
};

/** How long a working thread has been at it, in whole minutes (`3m`, `1h 5m`); empty under a minute. */
const workingFor = (thread: OrchestrationThreadShell, nowMs: number): string => {
  const turn = thread.latestTurn;
  const from =
    turn !== null && turn.completedAt === null
      ? [turn.startedAt, turn.requestedAt, thread.session?.updatedAt]
      : [thread.session?.updatedAt];
  const started = from
    .map((iso) => (iso == null ? NaN : Date.parse(iso)))
    .find((ms) => !Number.isNaN(ms));
  if (started === undefined) return "";
  const minutes = Math.floor(Math.max(0, nowMs - started) / MINUTE);
  if (minutes < 1) return "";
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};

/**
 * The status the desktop row shows, in its order: working, monitoring, approval, input, failed,
 * then a wake or an unseen answer, else nothing (`ready`). Approval and input outrank a running
 * session, as `resolveSidebarThreadStatus` has it.
 */
const statusOf = (
  thread: OrchestrationThreadShell,
  extra: { readonly woke: boolean; readonly unread: boolean },
): NavStatus => {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (thread.session?.status === "running" || thread.session?.status === "starting") {
    return "working";
  }
  if (thread.session?.status === "error") return "failed";
  if (thread.backgroundLiveness === "working") return "working";
  if (thread.backgroundLiveness === "monitoring") return "monitoring";
  if (extra.woke) return "woke";
  return extra.unread ? "unread" : "ready";
};

export interface SidebarInput {
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly projects: ReadonlyArray<OrchestrationProjectShell>;
  /** The thread on screen; null for a draft. */
  readonly currentId: string | null;
  /** The screen is a draft: the new-thread row is the current one. */
  readonly draft: boolean;
  readonly now: number;
  /** When each thread was last on screen (epoch ms): a wake or an answer after it is unseen. */
  readonly visited: ReadonlyMap<string, number>;
  readonly view: SidebarView;
}

/**
 * The thread list as the desktop app's sidebar builds it from the same shell: archived threads and
 * crew tasks leave the list (a crew task is counted under its lead, unless it waits for the user),
 * the rest fall in the pinned, active, snoozed and settled sections, ordered with the shared helpers
 * of `client-runtime` (pinned by their arranged keys, active with new and reopened threads first,
 * snoozed by wake time, settled by when the work ended). Snoozed and settled are shelves that start
 * closed; the thread on screen stays visible on a closed shelf. A row says which project it is in.
 */
export const buildSidebar = (input: SidebarInput): NavItem[] => {
  const { threads, now, view } = input;
  const nowIso = new Date(now).toISOString();
  const names = new Map(input.projects.map((project) => [project.id as string, project.title]));
  const live = threads.filter((thread) => thread.archivedAt === null);
  const listed = new Set(live.map((thread) => thread.id as string));
  const folded = new Map<string, number>();
  const top: OrchestrationThreadShell[] = [];
  for (const thread of live) {
    const waiting = thread.hasPendingApprovals || thread.hasPendingUserInput;
    if (!isCrewSubThread(thread) || waiting) {
      top.push(thread);
    } else if (thread.parentThreadId != null && listed.has(thread.parentThreadId)) {
      folded.set(thread.parentThreadId, (folded.get(thread.parentThreadId) ?? 0) + 1);
    }
  }

  const pinned: OrchestrationThreadShell[] = [];
  const active: OrchestrationThreadShell[] = [];
  const snoozed: OrchestrationThreadShell[] = [];
  const settled: OrchestrationThreadShell[] = [];
  for (const thread of top) {
    if (effectiveSnoozed(thread, { now: nowIso })) snoozed.push(thread);
    else if (thread.settledOverride === "settled") settled.push(thread);
    else if (thread.pinnedAt != null) pinned.push(thread);
    else active.push(thread);
  }
  snoozed.sort(
    (left, right) =>
      (Date.parse(left.snoozedUntil ?? "") || 0) - (Date.parse(right.snoozedUntil ?? "") || 0),
  );

  const row = (thread: OrchestrationThreadShell, section: NavSection): NavItem => {
    const id = thread.id as string;
    const current = input.currentId === id;
    const seen = input.visited.get(id) ?? now;
    const wokeAt = section === "settled" ? null : threadWokeAt(thread, { now: nowIso });
    const woke = !current && wokeAt !== null && Date.parse(wokeAt) > seen;
    const completed = thread.latestTurn?.completedAt;
    const unread =
      !current &&
      thread.latestTurn?.state === "completed" &&
      completed != null &&
      Date.parse(completed) > seen;
    const status = statusOf(thread, { woke, unread });
    const since =
      status === "working"
        ? workingFor(thread, now)
        : section === "snoozed" && thread.snoozedUntil != null
          ? snoozeWakeLabel(thread.snoozedUntil, { now: nowIso })
          : section === "settled"
            ? compactAge(resolveSettledThreadTimestamp(thread), now)
            : compactAge(thread.latestUserMessageAt ?? thread.updatedAt, now);
    const waitingCrew =
      isCrewSubThread(thread) && (thread.hasPendingApprovals || thread.hasPendingUserInput);
    return {
      kind: "thread",
      key: id,
      id,
      project: names.get(thread.projectId as string) ?? null,
      title: waitingCrew ? `crew ${crewSubThreadLabel(thread.title)}` : thread.title,
      status,
      since,
      pinned: thread.pinnedAt != null,
      current,
      crew: folded.get(id) ?? 0,
      section,
    };
  };

  const items: NavItem[] = [{ kind: "new", key: "new:", current: input.draft }];
  const sortedPinned = sortPinnedThreadsByOrderKey(pinned);
  const sortedActive = sortActiveThreadsByOrderKey(active);
  if (sortedPinned.length > 0) {
    items.push({ kind: "section", key: "section:pinned", section: "pinned" });
    items.push(...sortedPinned.map((thread) => row(thread, "pinned")));
    if (sortedActive.length > 0) {
      items.push({ kind: "section", key: "section:active", section: "active" });
    }
  }
  items.push(...sortedActive.map((thread) => row(thread, "active")));

  const shelf = (
    section: "snoozed" | "settled",
    all: ReadonlyArray<OrchestrationThreadShell>,
    open: boolean,
    limit: number,
  ): void => {
    if (all.length === 0) return;
    items.push({ kind: "shelf", key: `shelf:${section}`, section, count: all.length, open });
    const shown = open
      ? all.slice(0, limit)
      : all.filter((thread) => thread.id === input.currentId);
    items.push(...shown.map((thread) => row(thread, section)));
    if (open && all.length > shown.length) {
      items.push({ kind: "more", key: `more:${section}`, count: all.length - shown.length });
    }
  };
  shelf("snoozed", snoozed, view.snoozedOpen, Number.POSITIVE_INFINITY);
  shelf("settled", sortSettledThreads(settled), view.settledOpen, view.settledShown);
  return items;
};
