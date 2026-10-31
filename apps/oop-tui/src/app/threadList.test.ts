import { describe, expect, it } from "vite-plus/test";

import { makeThreadShell } from "../testing/fixtures.ts";
import { filterProjects, threadRows, topPinOrderKey } from "./threadList.ts";
import { makeProject } from "../testing/fixtures.ts";

const thread = (id: string, title: string, over: Record<string, unknown> = {}) =>
  makeThreadShell({ id, title, updatedAt: "2026-10-30T08:00:00.000Z", ...over });

const ids = (rows: ReadonlyArray<{ readonly id: string }>) => rows.map((row) => row.id);

describe("threadRows", () => {
  const threads = [
    thread("old", "오래된 작업", { updatedAt: "2026-10-01T08:00:00.000Z" }),
    thread("new", "최근 작업", { updatedAt: "2026-10-30T08:00:00.000Z" }),
    thread("mid", "login 버그 수정", { updatedAt: "2026-10-15T08:00:00.000Z" }),
  ];

  it("lists the newest first when nothing is pinned or typed", () => {
    expect(ids(threadRows(threads, "project-1", "").rows)).toEqual(["new", "mid", "old"]);
  });

  it("puts pinned threads first, in the desktop's pinned order", () => {
    const pinned = [
      ...threads,
      thread("pin-b", "고정 B", {
        pinnedAt: "2026-10-02T00:00:00.000Z",
        pinOrderKey: "n",
        updatedAt: "2026-09-01T00:00:00.000Z",
      }),
      thread("pin-a", "고정 A", {
        pinnedAt: "2026-10-03T00:00:00.000Z",
        pinOrderKey: "g",
        updatedAt: "2026-08-01T00:00:00.000Z",
      }),
    ];
    expect(ids(threadRows(pinned, "project-1", "").rows)).toEqual([
      "pin-a",
      "pin-b",
      "new",
      "mid",
      "old",
    ]);
  });

  it("keeps archived threads and other projects out", () => {
    const rows = threadRows(
      [
        ...threads,
        thread("gone", "보관됨", { archivedAt: "2026-10-31T00:00:00.000Z" }),
        thread("other", "다른 프로젝트", { projectId: "project-2" }),
      ],
      "project-1",
      "",
    ).rows;
    expect(ids(rows)).toEqual(["new", "mid", "old"]);
  });

  it("filters by title, Korean included, and puts the better match first", () => {
    expect(ids(threadRows(threads, "project-1", "작업").rows)).toEqual(["new", "old"]);
    expect(ids(threadRows(threads, "project-1", "LOGIN").rows)).toEqual(["mid"]);
    expect(ids(threadRows(threads, "project-1", "login 수정").rows)).toEqual(["mid"]);
    expect(ids(threadRows(threads, "project-1", "없는말").rows)).toEqual([]);
  });

  it("searches pinned threads too, and keeps them ahead on a tie", () => {
    const rows = threadRows(
      [...threads, thread("pin", "최근 고정", { pinnedAt: "2026-10-02T00:00:00.000Z" })],
      "project-1",
      "최근",
    ).rows;
    expect(ids(rows)).toEqual(["pin", "new"]);
  });
});

describe("filterProjects", () => {
  const projects = [
    makeProject({ id: "a", title: "웹 앱", workspaceRoot: "/work/web" }),
    makeProject({ id: "b", title: "server", workspaceRoot: "/work/api" }),
  ];

  it("matches the title or the folder", () => {
    expect(ids(filterProjects(projects, "웹"))).toEqual(["a"]);
    expect(ids(filterProjects(projects, "api"))).toEqual(["b"]);
    expect(filterProjects(projects, "")).toBe(projects);
  });

  it("finds a folder macOS spells with decomposed Korean letters, and the other way round", () => {
    const folders = [
      makeProject({ id: "nfd", title: "x", workspaceRoot: "/work/한글 폴더".normalize("NFD") }),
      makeProject({ id: "nfc", title: "y".normalize("NFC"), workspaceRoot: "/work/문서" }),
    ];
    expect(ids(filterProjects(folders, "한글".normalize("NFC")))).toEqual(["nfd"]);
    expect(ids(filterProjects(folders, "문서".normalize("NFD")))).toEqual(["nfc"]);
  });
});

describe("topPinOrderKey", () => {
  it("sorts before every key in use", () => {
    const key = topPinOrderKey([
      thread("a", "A", { pinnedAt: "2026-10-02T00:00:00.000Z", pinOrderKey: "m" }),
      thread("b", "B", { pinnedAt: "2026-10-02T00:00:00.000Z", pinOrderKey: "f" }),
      thread("c", "C", { pinOrderKey: "a" }),
    ]);
    expect(key).toBeDefined();
    expect(key! < "f").toBe(true);
  });

  it("is a key of its own when nothing is arranged yet", () => {
    expect(topPinOrderKey([thread("a", "A")])).toBeDefined();
  });
});
