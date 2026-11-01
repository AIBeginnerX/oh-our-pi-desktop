import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import {
  MIN_NAV_COLUMNS,
  MIN_NAV_ROWS,
  navBottomRows,
  navColumns,
  navUnavailable,
  renderNavPane,
  type NavItem,
} from "./navPane.ts";
import { navPlacement, splitLayout } from "./splitRegion.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
type ThreadItem = Extract<NavItem, { kind: "thread" }>;
const row = (id: string, title: string, over: Partial<ThreadItem> = {}): ThreadItem => ({
  kind: "thread",
  key: id,
  id,
  project: "내 프로젝트",
  title,
  status: "ready",
  since: "5m",
  pinned: false,
  current: false,
  crew: 0,
  section: "active",
  ...over,
});
const fresh: NavItem = { kind: "new", key: "new:", current: false };
const draw = (
  list: ReadonlyArray<NavItem>,
  over: Partial<Parameters<typeof renderNavPane>[1]> = {},
): string[] =>
  renderNavPane(list, {
    columns: 28,
    rows: 20,
    theme,
    symbols: UNICODE_SYMBOLS,
    focused: false,
    selected: 0,
    loading: false,
    ...over,
  }).map(stripAnsi);

describe("navUnavailable", () => {
  it("needs a few rows and columns, in either place", () => {
    expect(navUnavailable(MIN_NAV_COLUMNS, MIN_NAV_ROWS)).toBeNull();
    expect(navUnavailable(MIN_NAV_COLUMNS - 1, 40)).toContain(String(MIN_NAV_COLUMNS));
    expect(navUnavailable(140, MIN_NAV_ROWS - 1)).toContain(String(MIN_NAV_ROWS));
  });
});

describe("where the list sits", () => {
  it("takes a column on the left while the conversation keeps 44 cells, else goes under it", () => {
    expect(navPlacement(140, false)).toBe("left");
    expect(navPlacement(80, false)).toBe("left");
    expect(navPlacement(70, false)).toBe("left");
    expect(navPlacement(69, false)).toBe("bottom");
    expect(navPlacement(60, false)).toBe("bottom");
    // With the side panel open the column needs more room.
    expect(navPlacement(160, true)).toBe("left");
    expect(navPlacement(114, true)).toBe("left");
    expect(navPlacement(104, true)).toBe("bottom");
  });

  it("splits the width into list, divider, conversation, divider, panel and one spare cell", () => {
    for (const columns of [70, 80, 140, 200]) {
      const nav = navColumns(columns);
      const plain = splitLayout(columns, false, nav);
      expect(plain.nav + 1 + plain.left + 1).toBe(columns);
    }
    for (const columns of [114, 140, 200]) {
      const panel = splitLayout(columns, true, navColumns(columns));
      expect(panel.nav + 1 + panel.left + 1 + panel.panel + 1).toBe(columns);
    }
    // Without the list nothing changes for the layouts that already existed.
    expect(splitLayout(120)).toEqual({ nav: 0, left: 120 - 2 - 45, panel: 45 });
    expect(splitLayout(120, false)).toEqual({ nav: 0, left: 119, panel: 0 });
  });

  it("gives the bottom list a third fewer rows when the task list shares the place", () => {
    expect(navBottomRows(24, false)).toBe(6);
    expect(navBottomRows(40, false)).toBe(8);
    expect(navBottomRows(24, true)).toBe(4);
  });
});

describe("renderNavPane", () => {
  const list: NavItem[] = [
    fresh,
    { kind: "section", key: "section:pinned", section: "pinned" },
    row("a", "고정한 스레드", { pinned: true, section: "pinned", since: "2d" }),
    { kind: "section", key: "section:active", section: "active" },
    row("b", "지금 스레드", { current: true, status: "working", since: "3m" }),
    row("c", "승인을 기다리는 스레드", { status: "approval" }),
    { kind: "shelf", key: "shelf:snoozed", section: "snoozed", count: 2, open: false },
    { kind: "shelf", key: "shelf:settled", section: "settled", count: 40, open: false },
  ];

  it("is exactly the rows and columns asked for, in the roomy and the compact form", () => {
    for (const rows of [5, 8, 12, 20]) {
      const lines = draw(list, { rows });
      expect(lines).toHaveLength(rows);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(28);
    }
    expect(draw([], { rows: 6 })).toHaveLength(6);
  });

  it("lays the list out like the desktop sidebar: sections, project over title, status or age", () => {
    const lines = draw(list);
    expect(lines[0]).toMatch(/^── 스레드 ─+$/u);
    expect(lines[1]).toBe("    + 새 스레드");
    expect(lines[2]).toBe("  고정됨");
    expect(lines[3]).toBe("    내 프로젝트 고정      2d");
    expect(lines[4]).toBe("    고정한 스레드");
    expect(lines[5]).toBe("  활성");
    // The current thread is marked, and a working one says so with how long it has worked.
    expect(lines[6]).toBe(" ◆◐ 내 프로젝트   작업 중 3m");
    expect(lines[7]).toBe("    지금 스레드");
    expect(lines[8]).toBe("  ▲ 내 프로젝트    승인 필요");
    expect(lines[9]).toBe("    승인을 기다리는 스레드");
    expect(lines[10]).toBe("   ▸ 미룸 (2)");
    expect(lines[11]).toBe("   ▸ 정리됨 (40)");
    expect(lines.at(-1)).toBe("Tab 으로 선택");
  });

  it("shows every status the desktop row has, each with its own mark", () => {
    const statuses = [
      "working",
      "monitoring",
      "approval",
      "input",
      "failed",
      "woke",
      "unread",
    ] as const;
    const lines = draw(
      statuses.map((status) => row(status, `t-${status}`, { status, project: null })),
      { rows: 24, columns: 40 },
    ).join("\n");
    for (const word of [
      "작업 중",
      "지켜보는 중",
      "승인 필요",
      "입력 필요",
      "실패",
      "깨어남",
      "응답 완료",
    ]) {
      expect(lines).toContain(word);
    }
    for (const mark of ["◐", "‖", "▲", "?", "✗", "●"]) expect(lines).toContain(mark);
  });

  it("folds crew tasks into a count on the title row", () => {
    expect(draw([row("a", "리드", { crew: 3 })]).join("\n")).toContain("리드 크루 3");
  });

  it("puts the project name on a row of its own width without pushing the status out", () => {
    const lines = draw([
      row("a", "제목", { project: "아주아주아주긴프로젝트이름입니다", status: "approval" }),
    ]);
    expect(lines[1]).toMatch(/승인 필요$/u);
    expect(visibleWidth(lines[1] ?? "")).toBeLessThanOrEqual(28);
  });

  it("shows the pick only while the list has the keys, and an open shelf's chevron", () => {
    const lines = draw(
      [
        fresh,
        row("a", "하나"),
        { kind: "shelf", key: "shelf:settled", section: "settled", count: 3, open: true },
      ],
      { focused: true, selected: 2 },
    );
    expect(lines.join("\n")).toContain("❯  ▾ 정리됨");
    expect(lines.at(-1)).toBe("↑↓ Enter Esc");
    expect(draw([fresh, row("a", "하나")]).join("\n")).not.toContain("❯");
  });

  it("offers more of a shelf", () => {
    expect(draw([fresh, { kind: "more", key: "more:settled", count: 30 }]).join("\n")).toContain(
      "30개 더 보기",
    );
  });

  it("scrolls whole entries to keep the pick in view and counts what is cut off", () => {
    const many = [fresh, ...Array.from({ length: 20 }, (_, i) => row(`t${i}`, `스레드 ${i}`))];
    const lines = draw(many, { rows: 9, focused: true, selected: 10 });
    expect(lines.join("\n")).toContain("스레드 9");
    expect(lines.join("\n")).toMatch(/… 위로 \d+개/u);
    expect(lines.join("\n")).toMatch(/… 아래로 \d+개/u);
    expect(lines).toHaveLength(9);
  });

  it("without focus keeps the thread on screen in view", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      row(`t${i}`, `스레드 ${i}`, { current: i === 15 }),
    );
    expect(draw(many, { rows: 9 }).join("\n")).toContain("◆");
  });

  it("says when there is nothing, no project, or the threads are still being read", () => {
    expect(draw([])[1]).toBe("아직 스레드가 없습니다");
    expect(draw([], { loading: true })[1]).toBe("불러오는 중…");
    expect(draw([fresh], { noProjects: true }).join("\n")).toContain("아직 프로젝트가 없습니다");
    expect(draw([fresh]).join("\n")).toContain("아직 스레드가 없습니다");
  });

  it("uses only ASCII marks with the ASCII symbols", () => {
    const lines = draw(list, { symbols: ASCII_SYMBOLS, focused: true, selected: 4 });
    expect(lines[0]).toMatch(/^-- 스레드 -+$/u);
    expect(lines.join("\n")).not.toMatch(/[─◆◐▲❯▸▾‖✗●]/u);
  });
});
