import type { ActivePlanState } from "@t3tools/client-runtime/thread-plan";
import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";
import { renderTasksPane, tasksPaneRows, tasksUnavailable } from "./tasksPane.ts";

const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);

const planOf = (
  statuses: ReadonlyArray<"pending" | "inProgress" | "completed">,
  explanation?: string,
): ActivePlanState => ({
  createdAt: "2026-10-30T09:00:00.000Z",
  turnId: null,
  ...(explanation === undefined ? {} : { explanation }),
  steps: statuses.map((status, index) => ({ step: `단계 ${index + 1}`, status })),
});

const draw = (
  plan: ActivePlanState,
  rows: number,
  columns = 40,
  symbols = UNICODE_SYMBOLS,
): string[] =>
  renderTasksPane({ kind: "plan", plan }, { columns, rows, theme, symbols }).map(stripAnsi);

describe("renderTasksPane", () => {
  it("heads the list with the finished count and marks each step by its state", () => {
    const rows = draw(planOf(["completed", "inProgress", "pending"]), 8);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatch(/^── 작업 1\/3 ─+$/u);
    expect(rows.slice(1, 4)).toEqual(["  ☑ 단계 1", "  ◐ 단계 2", "  ☐ 단계 3"]);
    expect(rows.slice(4)).toEqual(["", "", "", ""]);
  });

  it("puts the explanation on one line under the header", () => {
    const rows = draw(planOf(["pending"], "Claude\nTasks   now"), 6);
    expect(rows.slice(0, 3)).toEqual([
      expect.stringContaining("작업 0/1"),
      "Claude Tasks now",
      "  ☐ 단계 1",
    ]);
  });

  it("says there is no list yet, or that the thread is still being read", () => {
    const options = { columns: 40, rows: 5, theme, symbols: UNICODE_SYMBOLS };
    const empty = renderTasksPane({ kind: "empty" }, options).map(stripAnsi);
    expect(empty[0]).toMatch(/^── 작업 ─+$/u);
    expect(empty[1]).toBe("아직 작업 목록이 없습니다");
    expect(renderTasksPane({ kind: "loading" }, options).map(stripAnsi)[1]).toBe("불러오는 중…");
  });

  it("cuts a long step to the width, and a wide character never straddles the edge", () => {
    const plan: ActivePlanState = {
      ...planOf(["pending"]),
      steps: [{ step: "가".repeat(40), status: "pending" }],
    };
    for (const row of renderTasksPane(
      { kind: "plan", plan },
      { columns: 21, rows: 5, theme, symbols: UNICODE_SYMBOLS },
    )) {
      expect(visibleWidth(row)).toBeLessThanOrEqual(21);
    }
  });

  it("scrolls to the step under way and counts what is cut off above and below", () => {
    const statuses = Array.from({ length: 12 }, (_, i) =>
      i < 6 ? ("completed" as const) : i === 6 ? ("inProgress" as const) : ("pending" as const),
    );
    const rows = draw(planOf(statuses), 7);
    expect(rows).toHaveLength(7);
    expect(rows).toContain("  ◐ 단계 7");
    expect(rows.some((row) => /^… 위로 \d+개$/u.test(row))).toBe(true);
    expect(rows.some((row) => /^… 아래로 \d+개$/u.test(row))).toBe(true);
    const shown = rows.filter((row) => row.startsWith("  ")).length;
    const above = Number(rows.find((row) => row.startsWith("… 위로"))?.match(/\d+/u)?.[0]);
    const below = Number(rows.find((row) => row.startsWith("… 아래로"))?.match(/\d+/u)?.[0]);
    expect(above + shown + below).toBe(12);
  });

  it("gives the marker row back to the steps at either end", () => {
    const first = draw(planOf(["inProgress", ...Array<"pending">(9).fill("pending")]), 7);
    expect(first.some((row) => row.startsWith("… 위로"))).toBe(false);
    expect(first.filter((row) => row.startsWith("  "))).toHaveLength(5);
    expect(first).toContain("… 아래로 5개");
    const last = draw(planOf([...Array<"completed">(9).fill("completed"), "inProgress"]), 7);
    expect(last.some((row) => row.startsWith("… 아래로"))).toBe(false);
    expect(last).toContain("  ◐ 단계 10");
    expect(last).toContain("… 위로 5개");
  });

  it("keeps the last step in view once everything is done", () => {
    const rows = draw(planOf(Array<"completed">(10).fill("completed")), 6);
    expect(rows).toContain("  ☑ 단계 10");
  });

  it("draws in ASCII when asked to", () => {
    const rows = draw(planOf(["completed", "inProgress", "pending"]), 6, 40, ASCII_SYMBOLS);
    expect(rows.slice(0, 4)).toEqual([
      expect.stringMatching(/^-- 작업 1\/3 -+$/u),
      "  [x] 단계 1",
      "  [~] 단계 2",
      "  [ ] 단계 3",
    ]);
    expect(rows.join("")).toMatch(/^[\x20-\x7e가-힣]*$/u);
  });
});

describe("tasksPaneRows", () => {
  it("is about a third of the terminal, within bounds", () => {
    expect(tasksPaneRows(16)).toBe(5);
    expect(tasksPaneRows(30)).toBe(10);
    expect(tasksPaneRows(90)).toBe(12);
  });
});

describe("tasksUnavailable", () => {
  it("refuses a terminal too short to keep a conversation above the list, or too narrow", () => {
    expect(tasksUnavailable(80, 16)).toBeNull();
    expect(tasksUnavailable(80, 15)).toContain("16줄 미만");
    expect(tasksUnavailable(39, 30)).toContain("40칸 미만");
  });
});
