import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { makeProject, makeThreadShell } from "../testing/fixtures.ts";
import {
  isThreadRunning,
  projectForDirectory,
  realDirectory,
  relativeTime,
  sortedProjects,
  threadsOfProject,
  windowAround,
} from "./projects.ts";
import { makeSession } from "../testing/fixtures.ts";

describe("projectForDirectory", () => {
  const outer = makeProject({ id: "outer", workspaceRoot: "/work" });
  const inner = makeProject({ id: "inner", workspaceRoot: "/work/app" });

  it("picks the deepest project that contains the folder", () => {
    expect(projectForDirectory([outer, inner], "/work/app/src", "darwin")?.id).toBe("inner");
    expect(projectForDirectory([outer, inner], "/work/other", "darwin")?.id).toBe("outer");
  });

  it("compares real paths, so a symlinked workspace still matches", () => {
    const linked = makeProject({ id: "linked", workspaceRoot: "/tmp/app" });
    const canonical = (path: string) => path.replace(/^\/tmp\//u, "/private/tmp/");
    expect(projectForDirectory([linked], "/private/tmp/app/src", "darwin")).toBeUndefined();
    expect(projectForDirectory([linked], "/private/tmp/app/src", "darwin", canonical)?.id).toBe(
      "linked",
    );
  });

  it("resolves real symlinks on disk and falls back to the input when a path is gone", async () => {
    const base = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-real-")),
    );
    try {
      const real = NodePath.join(base, "real");
      await NodeFSP.mkdir(NodePath.join(real, "src"), { recursive: true });
      const link = NodePath.join(base, "link");
      await NodeFSP.symlink(real, link);
      const project = makeProject({ id: "p", workspaceRoot: link });
      expect(
        projectForDirectory([project], NodePath.join(real, "src"), "darwin", realDirectory)?.id,
      ).toBe("p");
      expect(realDirectory(NodePath.join(base, "missing"))).toBe(NodePath.join(base, "missing"));
    } finally {
      await NodeFSP.rm(base, { recursive: true, force: true });
    }
  });

  it("does not match a sibling that only shares a prefix", () => {
    expect(projectForDirectory([inner], "/work/application", "darwin")).toBeUndefined();
  });

  it("ignores case and separators on Windows only", () => {
    const windows = makeProject({ id: "w", workspaceRoot: "C:\\Users\\Kim\\App" });
    expect(projectForDirectory([windows], "c:/users/kim/app/src", "win32")?.id).toBe("w");
    expect(projectForDirectory([windows], "c:/users/kim/app/src", "linux")).toBeUndefined();
  });

  it("tolerates a trailing slash", () => {
    expect(projectForDirectory([inner], "/work/app/", "darwin")?.id).toBe("inner");
  });
});

describe("thread ordering", () => {
  const threads = [
    makeThreadShell({ id: "a", updatedAt: "2026-10-01T00:00:00.000Z" }),
    makeThreadShell({ id: "b", updatedAt: "2026-10-03T00:00:00.000Z" }),
    makeThreadShell({
      id: "c",
      updatedAt: "2026-10-05T00:00:00.000Z",
      archivedAt: "2026-10-06T00:00:00.000Z",
    }),
    makeThreadShell({ id: "d", projectId: "project-2", updatedAt: "2026-10-09T00:00:00.000Z" }),
  ];

  it("lists newest first and leaves out archived and foreign threads", () => {
    expect(threadsOfProject(threads, "project-1").map((thread) => thread.id)).toEqual(["b", "a"]);
  });

  it("orders projects by their latest live thread", () => {
    const projects = [
      makeProject({ id: "project-1", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeProject({ id: "project-2", updatedAt: "2026-01-01T00:00:00.000Z" }),
    ];
    expect(sortedProjects(projects, threads).map((project) => project.id)).toEqual([
      "project-2",
      "project-1",
    ]);
  });

  it("flags a thread whose session is running", () => {
    expect(isThreadRunning(makeThreadShell({ session: makeSession("running") }))).toBe(true);
    expect(isThreadRunning(makeThreadShell())).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-10-30T12:00:00.000Z");
  it("speaks in Korean units", () => {
    expect(relativeTime("2026-10-30T11:59:50.000Z", now)).toBe("방금");
    expect(relativeTime("2026-10-30T11:30:00.000Z", now)).toBe("30분 전");
    expect(relativeTime("2026-10-30T09:00:00.000Z", now)).toBe("3시간 전");
    expect(relativeTime("2026-10-27T12:00:00.000Z", now)).toBe("3일 전");
    expect(relativeTime("2026-08-01T12:00:00.000Z", now)).toBe("2026-08-01");
    expect(relativeTime("nonsense", now)).toBe("");
  });
});

describe("windowAround", () => {
  it("keeps the selected row inside the window and the window inside the list", () => {
    expect(windowAround(0, 20, 5)).toEqual({ start: 0, end: 5 });
    expect(windowAround(10, 20, 5)).toEqual({ start: 8, end: 13 });
    expect(windowAround(19, 20, 5)).toEqual({ start: 15, end: 20 });
    expect(windowAround(1, 3, 5)).toEqual({ start: 0, end: 3 });
  });

  it("shows no rows when no room is left", () => {
    expect(windowAround(2, 5, 0)).toEqual({ start: 2, end: 2 });
  });
});
