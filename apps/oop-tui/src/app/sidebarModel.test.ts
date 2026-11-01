import { describe, expect, it } from "vite-plus/test";

import type { NavItem } from "../render/navPane.ts";
import { makeProject, makeSession, makeThreadShell } from "../testing/fixtures.ts";
import {
  buildSidebar,
  compactAge,
  INITIAL_SIDEBAR_VIEW,
  SETTLED_INITIAL,
  type SidebarInput,
} from "./sidebarModel.ts";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const input = (
  threads: SidebarInput["threads"],
  over: Partial<SidebarInput> = {},
): SidebarInput => ({
  threads,
  projects: [makeProject()],
  currentId: null,
  draft: false,
  now: NOW,
  visited: new Map(),
  view: INITIAL_SIDEBAR_VIEW,
  ...over,
});

type Thread = Extract<NavItem, { kind: "thread" }>;
const threads = (items: ReadonlyArray<NavItem>): Thread[] =>
  items.filter((item): item is Thread => item.kind === "thread");
const kinds = (items: ReadonlyArray<NavItem>) =>
  items.map((item) => (item.kind === "thread" ? item.id : `${item.kind}`));

describe("compactAge", () => {
  it("uses the desktop sidebar's cut-offs", () => {
    expect(compactAge(ago(10_000), NOW)).toBe("now");
    expect(compactAge(ago(5 * MIN), NOW)).toBe("5m");
    expect(compactAge(ago(3 * HOUR), NOW)).toBe("3h");
    expect(compactAge(ago(50 * HOUR), NOW)).toBe("2d");
    expect(compactAge(null, NOW)).toBe("");
    expect(compactAge("not a date", NOW)).toBe("");
  });
});

describe("buildSidebar", () => {
  it("leads with the new-thread row, marked current for a draft", () => {
    expect(buildSidebar(input([], { draft: true }))[0]).toMatchObject({
      kind: "new",
      current: true,
    });
    expect(buildSidebar(input([]))[0]).toMatchObject({ kind: "new", current: false });
  });

  it("names the project on each row and the age of the last message", () => {
    const [row] = threads(
      buildSidebar(input([makeThreadShell({ id: "t1", title: "작업", updatedAt: ago(5 * MIN) })])),
    );
    expect(row).toMatchObject({
      project: "내 프로젝트",
      title: "작업",
      since: "5m",
      section: "active",
    });
  });

  it("puts pinned threads first under a header, only when something is pinned", () => {
    const plain = buildSidebar(input([makeThreadShell({ id: "a", title: "A" })]));
    expect(kinds(plain)).toEqual(["new", "a"]);
    const items = buildSidebar(
      input([
        makeThreadShell({ id: "a", title: "A", updatedAt: ago(MIN) }),
        makeThreadShell({ id: "p", title: "P", pinnedAt: ago(HOUR) }),
      ]),
    );
    expect(kinds(items)).toEqual(["new", "section", "p", "section", "a"]);
    expect(threads(items)[0]).toMatchObject({ id: "p", pinned: true, section: "pinned" });
  });

  it("drops archived threads and folds crew tasks into their lead's count", () => {
    const items = buildSidebar(
      input([
        makeThreadShell({ id: "lead", title: "Lead" }),
        makeThreadShell({ id: "gone", title: "Old", archivedAt: ago(HOUR) }),
        makeThreadShell({ id: "task", title: "[crew] worker: x", parentThreadId: "lead" }),
      ]),
    );
    expect(threads(items).map((row) => row.id)).toEqual(["lead"]);
  });

  it("shows approval and input ahead of a running session, and working for a running one", () => {
    const running = { session: makeSession("running", { updatedAt: ago(4 * MIN) }) };
    const items = buildSidebar(
      input([
        makeThreadShell({ id: "ap", title: "ap", hasPendingApprovals: true, ...running }),
        makeThreadShell({ id: "in", title: "in", hasPendingUserInput: true, ...running }),
        makeThreadShell({ id: "run", title: "run", ...running }),
      ]),
    );
    const status = Object.fromEntries(threads(items).map((row) => [row.id, row.status]));
    expect(status).toMatchObject({ ap: "approval", in: "input" });
    expect(status.run).toBe("working");
  });

  it("keeps the settled shelf closed with a count, but leaves the current thread visible", () => {
    const settled = (id: string) =>
      makeThreadShell({ id, title: id, settledOverride: "settled", updatedAt: ago(HOUR) });
    const all = [settled("s1"), settled("s2")];
    const closed = buildSidebar(input(all));
    expect(closed.find((item) => item.kind === "shelf")).toMatchObject({
      section: "settled",
      count: 2,
      open: false,
    });
    expect(threads(closed)).toHaveLength(0);
    expect(threads(buildSidebar(input(all, { currentId: "s2" }))).map((row) => row.id)).toEqual([
      "s2",
    ]);
  });

  it("opens the settled shelf a page at a time with a more row for the rest", () => {
    const many = Array.from({ length: SETTLED_INITIAL + 5 }, (_, index) =>
      makeThreadShell({ id: `s${index}`, title: `s${index}`, settledOverride: "settled" }),
    );
    const items = buildSidebar(
      input(many, { view: { ...INITIAL_SIDEBAR_VIEW, settledOpen: true } }),
    );
    expect(threads(items)).toHaveLength(SETTLED_INITIAL);
    expect(items.at(-1)).toMatchObject({ kind: "more", count: 5 });
  });
});
