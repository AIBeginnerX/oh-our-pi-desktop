import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import {
  MIN_NAV_COLUMNS,
  MIN_NAV_ROWS,
  navBottomRows,
  navColumns,
  navUnavailable,
  renderNavPane,
  type NavRow,
} from "./navPane.ts";
import { navPlacement, splitLayout } from "./splitRegion.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
const row = (id: string | null, label: string, over: Partial<NavRow> = {}): NavRow => ({
  id,
  label,
  status: "idle",
  pinned: false,
  current: false,
  ...over,
});
const draw = (
  list: ReadonlyArray<NavRow>,
  over: Partial<Parameters<typeof renderNavPane>[1]> = {},
): string[] =>
  renderNavPane(list, {
    columns: 28,
    rows: 8,
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
  const list = [
    row(null, "새 스레드"),
    row("a", "고정한 스레드", { pinned: true }),
    row("b", "지금 스레드", { current: true, status: "running" }),
    row("c", "기다리는 스레드", { status: "waiting" }),
  ];

  it("is exactly the rows and columns asked for", () => {
    for (const lines of [draw(list), draw(list, { rows: 5 }), draw([], { rows: 6 })]) {
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(28);
    }
    expect(draw(list)).toHaveLength(8);
    expect(draw(list, { rows: 5 })).toHaveLength(5);
    expect(draw([], { rows: 6 })).toHaveLength(6);
  });

  it("marks the current thread, the state, the pin, and names the keys", () => {
    const lines = draw(list);
    expect(lines[0]).toMatch(/^── 스레드 ─+$/u);
    expect(lines[1]).toBe("    새 스레드");
    expect(lines[2]).toBe("    고정한 스레드 고정");
    expect(lines[3]).toBe(" ◆◐ 지금 스레드");
    expect(lines[4]).toBe("  ▲ 기다리는 스레드");
    expect(lines.at(-1)).toBe("Tab 으로 선택");
  });

  it("shows the pick only while the list has the keys", () => {
    const lines = draw(list, { focused: true, selected: 3 });
    expect(lines[4]).toBe("❯ ▲ 기다리는 스레드");
    expect(lines.slice(1, 4).every((line) => !line.startsWith("❯"))).toBe(true);
    expect(lines.at(-1)).toBe("↑↓ Enter Esc");
  });

  it("scrolls to keep the pick in view and counts what is cut off", () => {
    const many = Array.from({ length: 20 }, (_, i) => row(`t${i}`, `스레드 ${i}`));
    const lines = draw(many, { rows: 7, focused: true, selected: 10 });
    expect(lines.join("\n")).toContain("❯   스레드 10");
    expect(lines.join("\n")).toMatch(/… 위로 \d+개/u);
    expect(lines.join("\n")).toMatch(/… 아래로 \d+개/u);
    expect(lines).toHaveLength(7);
  });

  it("without focus keeps the thread on screen in view", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      row(`t${i}`, `스레드 ${i}`, { current: i === 15 }),
    );
    expect(draw(many, { rows: 7 }).join("\n")).toContain("◆");
  });

  it("says when there is nothing, or the threads are still being read", () => {
    expect(draw([])[1]).toBe("아직 스레드가 없습니다");
    expect(draw([], { loading: true })[1]).toBe("불러오는 중…");
  });

  it("uses only ASCII marks with the ASCII symbols", () => {
    const lines = draw(list, { symbols: ASCII_SYMBOLS, focused: true, selected: 2 });
    expect(lines[0]).toMatch(/^-- 스레드 -+$/u);
    expect(lines.join("\n")).not.toMatch(/[─◆◐▲❯]/u);
  });
});
