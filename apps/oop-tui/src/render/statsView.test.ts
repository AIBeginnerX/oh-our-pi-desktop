import { describe, expect, it } from "vite-plus/test";

import { makeActivity } from "../testing/fixtures.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import { renderStats, type StatsInput } from "./statsView.ts";
import { makeStyle } from "./style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

/** An instant that reads as `hour:minute` on the clock of whoever runs the test, whatever their zone. */
const local = (hour: number, minute = 0) => new Date(2026, 9, 30, hour, minute).toISOString();

let counter = 0;
const done = (
  title: string,
  at: string,
  payload: Record<string, unknown> = {},
  kind = "tool.completed",
) =>
  makeActivity({ id: `a${(counter += 1)}`, kind, createdAt: at, payload: { title, ...payload } });
const failed = (title: string, at: string, reason = "") =>
  done(title, at, {
    status: "failed",
    ...(reason === "" ? {} : { data: { item: { aggregatedOutput: reason } } }),
  });

const many = (count: number, make: (index: number) => ReturnType<typeof done>) =>
  Array.from({ length: count }, (_, index) => make(index));

const render = (over: Partial<StatsInput> = {}) =>
  renderStats({
    activities: [],
    hasOlder: false,
    tab: 0,
    selected: null,
    width: 80,
    rows: 30,
    style: makeStyle(false),
    symbols: UNICODE_SYMBOLS,
    ...over,
  });

/** 40 calls of one tool with 3 failures, 5 clean calls of another. */
const sample = [
  ...many(37, (index) => done("Ran command", local(9, index))),
  ...many(3, (index) => failed("Ran command", local(16, index), "no such file")),
  ...many(5, (index) => done("Edit", local(16, 10 + index))),
];

describe("renderStats", () => {
  describe("an empty thread", () => {
    it("says so in one line under the tabs, on every tab", () => {
      for (const tab of [0, 1, 2] as const) {
        const rows = render({ tab });
        expect(rows).toHaveLength(3);
        expect(rows[1]).toBe("");
        expect(rows[2]).toBe(" 아직 집계할 도구 활동이 없습니다");
      }
    });

    it("still says when only the recent part of the thread is counted", () => {
      expect(render({ hasOlder: true }).at(-1)).toBe(
        " 아직 집계할 도구 활동이 없습니다  최근 활동만 집계",
      );
    });

    it("does not count a tool that has not finished, or other activity", () => {
      const rows = render({
        activities: [
          done("ls", local(9), {}, "tool.started"),
          done("ls", local(9), {}, "tool.updated"),
          makeActivity({ id: "w", kind: "runtime.warning", createdAt: local(9) }),
        ],
      });
      expect(rows.at(-1)).toBe(" 아직 집계할 도구 활동이 없습니다");
    });
  });

  describe("tabs", () => {
    it("marks the chosen tab with brackets when colour is off, and reverses it when it is on", () => {
      expect(render({ tab: 1 })[0]).toContain(">[2] 시간대<");
      expect(render({ tab: 1 })[0]).not.toContain(">[1] 개요<");
      const style = makeStyle(createTheme("oop", BUILTIN_THEMES.oop, 3));
      const head = render({ tab: 2, style })[0] as string;
      expect(head).toContain("\u001b[7m");
      expect(stripAnsi(head)).toContain(" [3] 도구 ");
    });

    it("puts the keys at the right edge when there is room, and drops them when there is not", () => {
      const wide = render({ width: 80 })[0] as string;
      expect(visibleWidth(wide)).toBe(80);
      expect(wide.endsWith("r:새로고침 q:닫기")).toBe(true);
      expect(render({ width: 40 })[0]).not.toContain("q:닫기");
    });
  });

  describe("overview", () => {
    it("counts tools, calls and the failure rate from finished and refused tools", () => {
      const rows = render({
        activities: [
          ...sample,
          done("rm", local(10), {}, "tool.denied"),
          done("pending", local(11), {}, "tool.started"),
        ],
      });
      // 3 failed + 1 refused out of 46 calls is 8.7%.
      expect(rows[2]).toBe(" 도구 3  호출 46  실패율 9%");
    });

    it("rates a thread with no failure at 0% and one with only failures at 100%", () => {
      expect(render({ activities: [done("ls", local(9))] })[2]).toBe(" 도구 1  호출 1  실패율 0%");
      expect(render({ activities: [failed("ls", local(9))] })[2]).toBe(
        " 도구 1  호출 1  실패율 100%",
      );
    });

    it("draws each tool, most called first, with a 20-cell bar and its split", () => {
      const rows = render({ activities: sample });
      expect(rows[4]).toBe(" Ran command ▒▒██████████████████ 3실패/37성공 40회");
      expect(rows[5]).toBe(" Edit        ████████████████████ 0실패/5성공 5회");
    });

    it("gives a tool with failures at least one cell, and keeps a cell for its successes", () => {
      const rare = [failed("a", local(9)), ...many(500, () => done("a", local(9)))];
      const bar = (render({ activities: rare })[4] as string).match(/[▒█]+/u)?.[0] ?? "";
      expect(bar).toBe(`▒${"█".repeat(19)}`);
      const mostly = [done("b", local(9)), ...many(500, () => failed("b", local(9)))];
      expect((render({ activities: mostly })[4] as string).match(/[▒█]+/u)?.[0]).toBe(
        `${"▒".repeat(19)}█`,
      );
    });

    it("tells failures from successes by colour, in the theme's error and success colours", () => {
      const theme = createTheme("oop", BUILTIN_THEMES.oop, 3);
      const row = render({ activities: sample, style: makeStyle(theme) })[4] as string;
      expect(row).toContain(theme.error("██"));
      expect(row).toContain(theme.success("█".repeat(18)));
    });

    it("names a tool the way a finished tool is named in the transcript", () => {
      const rows = render({
        activities: [
          makeActivity({
            id: "1",
            kind: "tool.completed",
            summary: "요약 이름",
            createdAt: local(9),
          }),
          makeActivity({
            id: "2",
            kind: "tool.completed",
            summary: "요약 이름",
            createdAt: local(9),
            payload: { title: "제목 이름" },
          }),
        ],
      });
      const text = rows.join("\n");
      expect(text).toContain("요약 이름");
      expect(text).toContain("제목 이름");
    });

    it("says only recent activity is counted when the server sent a window", () => {
      expect(render({ activities: sample, hasOlder: true })[2]).toBe(
        " 도구 2  호출 45  실패율 7%  최근 활동만 집계",
      );
      expect(render({ activities: sample, hasOlder: true, width: 30 }).slice(2, 4)).toEqual([
        " 도구 2  호출 45  실패율 7%",
        " 최근 활동만 집계",
      ]);
    });

    it("leaves the split out before the bar when the line is narrow", () => {
      const rows = render({ activities: sample, width: 32 });
      expect(rows[4]).toMatch(/^ Ran comma~ \S+ 40회$/u);
    });

    it("says how many tools it left out when the screen is short", () => {
      const tools = many(10, (index) => done(`tool-${index}`, local(9)));
      const rows = render({ activities: tools, rows: 8 });
      expect(rows).toHaveLength(8);
      expect(rows.at(-1)).toBe(" … 외 7개");
    });
  });

  describe("hours", () => {
    const hours = [
      ...many(4, (index) => done("a", local(16, index))),
      ...many(2, (index) => failed("a", local(16, 10 + index))),
      ...many(3, (index) => done("a", local(5, index))),
      ...many(3, (index) => done("a", local(1, index))),
      done("a", local(23)),
      done("a", local(0)),
    ];

    it("draws 24 cells in the viewer's own hours, darker where there were more calls", () => {
      const rows = render({ tab: 1, activities: hours });
      const cells = (rows.find((row) => row.startsWith(" 시간")) as string).replace(
        /^ 시간 {2}/u,
        "",
      );
      expect([...cells]).toHaveLength(24);
      const at = (hour: number) => [...cells][hour];
      expect(at(16)).toBe("█");
      expect(at(5)).toBe("▓");
      expect(at(1)).toBe("▓");
      expect(at(0)).toBe("▒");
      expect(at(23)).toBe("▒");
      expect(at(12)).toBe("░");
    });

    it("numbers the hours underneath, the way the 24 cells line up", () => {
      const rows = render({ tab: 1, activities: hours });
      const at = rows.findIndex((row) => row.startsWith(" 시간"));
      expect(rows[at + 1]).toBe("       0         1         2   ");
      expect(rows[at + 2]).toBe("       0    5    0    5    0  3");
    });

    it("names the busiest hour, and lists the top hours most first, earlier first on a tie", () => {
      const rows = render({ tab: 1, activities: hours });
      expect(rows[2]).toBe(" 호출 14  실패율 14%  최다 16:00");
      const list = rows.slice(rows.indexOf(" 많은 시간") + 1);
      expect(list).toEqual([
        "   16:00  6회  (2실패)",
        "   01:00  3회",
        "   05:00  3회",
        "   00:00  1회",
        "   23:00  1회",
      ]);
    });

    it("lists no more than five hours", () => {
      const spread = many(8, (index) => done("a", local(index * 2, 0)));
      const rows = render({ tab: 1, activities: spread });
      expect(rows.slice(rows.indexOf(" 많은 시간") + 1)).toHaveLength(5);
    });

    it("keeps a call with an unreadable time in the totals but out of the hours", () => {
      const rows = render({
        tab: 1,
        activities: [done("a", local(9)), done("a", "시간 아님")],
      });
      expect(rows[2]).toBe(" 호출 2  실패율 0%  최다 09:00");
      expect(rows.at(-1)).toBe("   09:00  1회");
    });

    it("draws the cells in ASCII under the ASCII symbols", () => {
      const rows = render({ tab: 1, activities: hours, symbols: ASCII_SYMBOLS });
      const cells = (rows.find((row) => row.startsWith(" 시간")) as string).replace(
        /^ 시간 {2}/u,
        "",
      );
      expect(cells).toMatch(/^[.:*#]{24}$/u);
    });
  });

  describe("one tool", () => {
    const tools = [
      ...many(3, (index) =>
        failed("Ran command", local(16, index), "cat: x: no such file\n두 번째 줄"),
      ),
      ...many(5, (index) => done("Ran command", local(9, index))),
      ...many(4, (index) => done("Edit", local(10, index))),
      done("Read", local(11)),
    ];

    it("lists the tools with the chosen one marked, and shows its numbers beside it", () => {
      const rows = render({ tab: 2, activities: tools, selected: "Ran command" });
      expect(rows[2]).toMatch(/^ ▶ Ran command \(8\) +╭─+╮$/u);
      expect(rows[3]).toMatch(/^ {3}Edit \(4\) +│ Ran command +│$/u);
      expect(rows.join("\n")).toContain("호출 8  실패 3  성공 5");
      expect(rows.join("\n")).toContain("마지막 호출 2026-10-30 16:02");
      expect(rows.join("\n")).toContain("마지막 실패 cat: x: no such file");
      expect(rows.join("\n")).not.toContain("두 번째 줄");
    });

    it("moves the mark and the box with the selection by name, and starts at the first for a name it lacks", () => {
      const second = render({ tab: 2, activities: tools, selected: "Edit" });
      expect(second[3]).toMatch(/^ ▶ Edit \(4\)/u);
      expect(second.join("\n")).toContain("호출 4  실패 0  성공 4");
      expect(second.join("\n")).toContain("마지막 실패 없음");
      const last = render({ tab: 2, activities: tools, selected: "Read" });
      expect(last.join("\n")).toMatch(/▶ Read \(1\)/u);
      const gone = render({ tab: 2, activities: tools, selected: "사라진 도구" });
      expect(gone.join("\n")).toMatch(/▶ Ran command \(8\)/u);
      expect(render({ tab: 2, activities: tools, selected: null }).join("\n")).toMatch(
        /▶ Ran command \(8\)/u,
      );
    });

    it("keeps the mark on the same tool when new calls reorder the list", () => {
      const marked = (activities: typeof tools) =>
        render({ tab: 2, activities, selected: "Edit" })
          .find((row) => row.includes("▶"))
          ?.match(/▶ (\S+)/u)?.[1];
      expect(marked(tools)).toBe("Edit");
      // Edit now has the most calls, so it moves to the top of the list; the pick stays on it.
      const busier = [...tools, ...many(9, (index) => done("Edit", local(12, index)))];
      expect(marked(busier)).toBe("Edit");
    });

    it("says the numbers cover only the recent activity on the tool tab as well", () => {
      expect(render({ tab: 2, activities: tools, hasOlder: true }).join("\n")).toContain(
        "최근 활동만 집계",
      );
      expect(render({ tab: 2, activities: tools }).join("\n")).not.toContain("최근 활동만 집계");
    });

    it("shows a refused tool as a failure, with the reason it was given", () => {
      const rows = render({
        tab: 2,
        activities: [
          makeActivity({
            id: "d",
            kind: "tool.denied",
            summary: "Tool denied: rm",
            createdAt: local(9),
            payload: { detail: "허용되지 않음" },
          }),
        ],
      });
      expect(rows.join("\n")).toContain("호출 1  실패 1  성공 0");
      expect(rows.join("\n")).toContain("마지막 실패 허용되지 않음");
    });

    it("stacks the box under the list on a narrow screen, inside the width", () => {
      const rows = render({ tab: 2, activities: tools, width: 40 });
      expect(rows[2]).toBe(" ▶ Ran command (8)");
      expect(rows.some((row) => row.startsWith(" ╭"))).toBe(true);
      for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    });

    it("keeps the chosen tool in view when the list is longer than the screen", () => {
      const lots = many(30, (index) => done(`tool-${String(index).padStart(2, "0")}`, local(9)));
      const rows = render({ tab: 2, activities: lots, selected: "tool-25", rows: 12 });
      expect(rows.join("\n")).toContain("▶ tool-25");
    });

    it("reads the last call in the viewer's own clock", () => {
      const rows = render({ tab: 2, activities: [done("a", local(7, 5))] });
      expect(rows.join("\n")).toContain("마지막 호출 2026-10-30 07:05");
    });
  });

  describe("server text", () => {
    it("strips control sequences from a tool's name and from why it failed", () => {
      const rows = render({
        tab: 2,
        activities: [failed("ls\u001b[2J\u001b]0;제목\u0007", local(9), "o\u001b[31mops\u0007")],
      });
      const text = rows.join("\n");
      expect(text).toContain("▶ ls (1)");
      expect(text).toContain("마지막 실패 oops");
      // eslint-disable-next-line no-control-regex
      expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f]/u);
    });
  });

  describe("plain and ASCII terminals", () => {
    it("writes no escape sequence when colour is off", () => {
      for (const tab of [0, 1, 2] as const) {
        expect(render({ tab, activities: sample }).join("\n")).not.toContain("\u001b");
      }
    });

    it("tells failed cells from the others without colour, so the bar still reads", () => {
      expect(render({ activities: sample })[4]).toContain("▒");
    });

    it("draws only ASCII outside the Korean wording under the ASCII symbols", () => {
      const symbols = ASCII_SYMBOLS;
      for (const tab of [0, 1, 2] as const) {
        const text = render({ tab, activities: sample, symbols }).join("\n");
        expect(text.replace(/[가-힣]/gu, "")).toMatch(/^[\n -~]+$/u);
      }
      expect(render({ tab: 2, activities: sample, symbols })[2]).toContain("> Ran command");
      expect(render({ activities: sample, symbols })[4]).toMatch(/x#+/u);
    });
  });

  describe("fitting the screen", () => {
    const korean = [
      ...many(12, (index) =>
        failed(
          `아주 긴 한국어 도구 이름 ${index} 번째 도구`,
          local(index, 7),
          "실패한 이유가 꽤 길게 적혀 있습니다 ".repeat(5),
        ),
      ),
      ...many(30, (index) => done(`도구 ${index % 7}`, local(index % 24, index))),
    ];

    it("never uses more rows than it was given, or more columns, on any tab at any size", () => {
      const styles = [makeStyle(false), makeStyle(createTheme("oop", BUILTIN_THEMES.oop, 3))];
      for (const style of styles) {
        for (const symbols of [UNICODE_SYMBOLS, ASCII_SYMBOLS]) {
          for (const tab of [0, 1, 2] as const) {
            for (const width of [1, 3, 8, 20, 32, 40, 59, 60, 80, 120]) {
              for (const rows of [0, 1, 2, 3, 5, 8, 14, 40]) {
                for (const selected of [null, "도구 5", "없는 도구"]) {
                  const out = renderStats({
                    activities: korean,
                    hasOlder: true,
                    tab,
                    selected,
                    width,
                    rows,
                    style,
                    symbols,
                  });
                  expect(out.length).toBeLessThanOrEqual(rows);
                  for (const row of out) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
                }
              }
            }
          }
        }
      }
    });

    it("draws the empty screen inside a narrow width too", () => {
      for (const width of [1, 10, 20, 40]) {
        for (const row of render({ width, hasOlder: true })) {
          expect(visibleWidth(row)).toBeLessThanOrEqual(width);
        }
      }
    });

    it("handles a long thread of activities in bounded time", () => {
      const lots = many(50_000, (index) =>
        done(`tool-${index % 500}`, local(index % 24, index % 60)),
      );
      const started = performance.now();
      for (const tab of [0, 1, 2] as const) render({ tab, activities: lots });
      expect(performance.now() - started).toBeLessThan(1500);
    });
  });
});
