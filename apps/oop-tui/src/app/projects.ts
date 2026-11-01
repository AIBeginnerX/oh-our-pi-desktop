import * as NodeFS from "node:fs";

import type { OrchestrationProjectShell, OrchestrationThreadShell } from "@t3tools/contracts";
import { t } from "../i18n/index.ts";

const normalizeDirectory = (value: string, platform: NodeJS.Platform): string => {
  let normalized = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  if (normalized === "") normalized = "/";
  return platform === "win32" ? normalized.toLowerCase() : normalized;
};

/** The real path of `path` (symlinks resolved), or `path` itself when it cannot be resolved. */
export const realDirectory = (path: string): string => {
  try {
    return NodeFS.realpathSync.native(path);
  } catch {
    return path;
  }
};

/**
 * The project whose workspace contains `directory`; the deepest root wins when projects nest.
 * `canonical` maps both sides to real paths, so `/tmp/app` and `/private/tmp/app` agree on macOS.
 */
export const projectForDirectory = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  directory: string,
  platform: NodeJS.Platform,
  canonical: (path: string) => string = (path) => path,
): OrchestrationProjectShell | undefined => {
  const target = normalizeDirectory(canonical(directory), platform);
  let best: OrchestrationProjectShell | undefined;
  let bestLength = -1;
  for (const project of projects) {
    const root = normalizeDirectory(canonical(project.workspaceRoot), platform);
    const contains = target === root || target.startsWith(root === "/" ? "/" : `${root}/`);
    if (contains && root.length > bestLength) {
      best = project;
      bestLength = root.length;
    }
  }
  return best;
};

/** Most recently touched first. Archived threads stay out of the picker. */
export const threadsOfProject = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projectId: string,
): OrchestrationThreadShell[] =>
  threads
    .filter((thread) => thread.projectId === projectId && thread.archivedAt === null)
    .toSorted((left, right) =>
      left.updatedAt < right.updatedAt ? 1 : left.updatedAt > right.updatedAt ? -1 : 0,
    );

export const sortedProjects = (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationProjectShell[] => {
  const latest = new Map<string, string>();
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const seen = latest.get(thread.projectId);
    if (seen === undefined || seen < thread.updatedAt)
      latest.set(thread.projectId, thread.updatedAt);
  }
  const touched = (project: OrchestrationProjectShell) =>
    latest.get(project.id) ?? project.updatedAt;
  return projects.toSorted((left, right) =>
    touched(left) < touched(right) ? 1 : touched(left) > touched(right) ? -1 : 0,
  );
};

export const isThreadRunning = (thread: OrchestrationThreadShell): boolean =>
  thread.session?.status === "running" ||
  thread.session?.status === "starting" ||
  thread.latestTurn?.state === "running";

/** Relative time for picker rows. */
export const relativeTime = (iso: string, now: Date): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 45) return t("session.time.now");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return t("session.time.min", { n: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 24) return t("session.time.hour", { n: hours });
  const days = Math.round(hours / 24);
  if (days < 30) return t("session.time.day", { n: days });
  return iso.slice(0, 10);
};

/** Rows to show for a list of `count` items when only `size` fit, keeping `selected` visible; none when none fit. */
export const windowAround = (
  selected: number,
  count: number,
  size: number,
): { readonly start: number; readonly end: number } => {
  const visible = Math.max(0, Math.min(size, count));
  const start = Math.max(0, Math.min(selected - Math.floor(visible / 2), count - visible));
  return { start, end: start + visible };
};
