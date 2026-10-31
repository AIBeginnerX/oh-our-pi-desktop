import { describe, expect, it } from "vite-plus/test";

import { stripAnsi } from "../text/width.ts";
import { LiveRegion, type RegionFrame, type Scheduler } from "./liveRegion.ts";

const harness = (startColumns = 20, rows = 10) => {
  let columns = startColumns;
  const writes: string[] = [];
  const pending: Array<() => void> = [];
  const schedule: Scheduler = (run) => {
    pending.push(run);
    return () => {
      const index = pending.indexOf(run);
      if (index >= 0) pending.splice(index, 1);
    };
  };
  const region = new LiveRegion(
    { write: (text) => writes.push(text), columns: () => columns, rows: () => rows },
    schedule,
  );
  const tick = () => pending.splice(0).forEach((run) => run());
  const resize = (next: number) => {
    columns = next;
    region.hold();
  };
  return { region, writes, pending, tick, resize };
};

const frame = (lines: string[], cursor: RegionFrame["cursor"] = null): RegionFrame => ({
  lines,
  cursor,
});

describe("LiveRegion", () => {
  it("collapses a burst of updates into one write on the next tick", () => {
    const { region, writes, pending, tick } = harness();
    region.set(frame(["a"]));
    region.set(frame(["b"]));
    region.commit(["done"]);
    expect(writes).toEqual([]);
    expect(pending).toHaveLength(1);
    tick();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("done\u001b[0m\r\n");
    expect(writes[0]).toContain("b");
    expect(writes[0]).not.toContain("a\r\n");
  });

  it("repaints nothing when nothing changed, so an idle terminal stays quiet", () => {
    const { region, writes, pending, tick } = harness();
    region.set(frame(["x"]));
    tick();
    tick();
    region.flush();
    expect(writes).toHaveLength(1);
    expect(pending).toHaveLength(0);
  });

  it("writes committed lines once and erases only the live rows when redrawing", () => {
    const { region, writes, tick } = harness();
    region.set(frame(["live 1", "live 2"], { row: 1, col: 3 }));
    tick();
    region.commit(["scrollback"]);
    tick();
    const second = writes[1] as string;
    // Cursor was left on row 1 of 2; the repaint climbs to the top of the region and clears below it.
    expect(second).toContain("\u001b[1A\r\u001b[J");
    expect(second.indexOf("scrollback")).toBeGreaterThan(second.indexOf("\u001b[J"));
    expect(writes.join("").split("scrollback")).toHaveLength(2);
  });

  it("places the real cursor by display column and shows it only when there is one", () => {
    const { region, writes, tick } = harness();
    region.set(frame(["> 한글"], { row: 0, col: 6 }));
    tick();
    expect(writes[0]).toContain("\r\u001b[6C");
    expect(writes[0]).toContain("\u001b[?25h");

    region.set(frame(["선택하세요"], null));
    tick();
    expect(writes[1]).not.toContain("\u001b[?25h");
    expect(writes[1]).toContain("\u001b[?25l");
  });

  it("wraps each paint in synchronized output so the terminal does not flicker", () => {
    const { region, writes, tick } = harness();
    region.set(frame(["x"]));
    tick();
    expect(writes[0]?.startsWith("\u001b[?2026h")).toBe(true);
    expect(writes[0]?.endsWith("\u001b[?2026l")).toBe(true);
  });

  it("cuts lines to the terminal width so a long line never wraps and breaks the row count", () => {
    const { region, writes, tick } = harness(10);
    region.set(frame(["가나다라마바사아자차카타"]));
    tick();
    const painted = stripAnsi(writes[0] as string).replaceAll("\r", "");
    expect(painted.endsWith("~")).toBe(true);
    expect(painted.length).toBeLessThanOrEqual(9);
  });

  it("keeps the bottom of a frame taller than the screen, where the composer lives", () => {
    const { region, writes, tick } = harness(20, 4);
    region.set(frame(["1", "2", "3", "4", "5", "입력"], { row: 5, col: 2 }));
    tick();
    const text = stripAnsi(writes[0] as string);
    expect(text).toContain("입력");
    expect(text).not.toContain("1\r\n");
  });

  it("clear erases the region and flushes pending commits above it", () => {
    const { region, writes } = harness();
    region.set(frame(["live"]));
    region.flush();
    region.commit(["마지막 줄"]);
    region.clear();
    const last = writes.at(-1) as string;
    expect(last).toContain("\u001b[J");
    expect(last).toContain("마지막 줄");
    region.flush();
    expect(writes.at(-1)).toBe(last);
  });

  it("abandon forgets the painted rows so a resize cannot erase unrelated output", () => {
    const { region, writes, tick } = harness();
    region.set(frame(["a", "b", "c"], { row: 0, col: 0 }));
    tick();
    region.abandon();
    // Moves below the old region, then repaints from there without climbing up.
    expect(writes[1]).toBe("\u001b[2B\r\n");
    tick();
    expect(writes[2]?.startsWith("\u001b[?2026h\u001b[?25l\r\u001b[J")).toBe(true);
  });

  it("folds a line queued during a resize, so its end reaches the scrollback", () => {
    const { region, writes, tick } = harness(10);
    region.hold();
    region.commit([`${"a".repeat(24)}END`]);
    tick();
    region.release();
    tick();
    const text = stripAnsi(writes.join(""));
    expect(text).toContain("END");
    expect(text.replaceAll(/\s/gu, "")).toContain(`${"a".repeat(24)}END`);
  });

  it("holds every paint from the first resize event until the size settles", () => {
    const { region, writes, tick } = harness();
    region.set(frame(["a", "b", "c"], { row: 0, col: 0 }));
    tick();
    region.hold();
    // Frames set by a timer meanwhile are not drawn.
    expect(writes).toHaveLength(1);
    region.set(frame(["a", "b", "tick 1"], { row: 0, col: 0 }));
    region.commit(["scrollback"]);
    tick();
    region.flush();
    region.set(frame(["a", "b", "tick 2"], { row: 0, col: 0 }));
    tick();
    expect(writes).toHaveLength(1);
    region.hold();
    expect(writes).toHaveLength(1);

    region.release();
    tick();
    expect(writes).toHaveLength(2);
    const drawn = writes[1] as string;
    expect(drawn.startsWith("\u001b[?2026h\u001b[?25l\r\u001b[J")).toBe(true);
    expect(drawn).toContain("scrollback");
    expect(drawn).toContain("tick 2");
    expect(drawn).not.toContain("tick 1");
  });

  it("leaves no copy behind when the window widens: it climbs the rows it drew and erases them", () => {
    const { region, writes, tick, resize } = harness(20);
    region.set(frame(["a", "b", "c"], { row: 2, col: 0 }));
    tick();
    resize(40);
    region.release();
    tick();
    expect(writes.at(-1)?.startsWith("\u001b[?2026h\u001b[?25l\u001b[2A\r\u001b[J")).toBe(true);
  });

  it("climbs the rows the terminal folded when the window narrows", () => {
    const { region, writes, tick, resize } = harness(30);
    // At 10 columns: 25 cells take 3 rows, then "b" 1, and the cursor sits in the 2nd row of its line.
    region.set(frame(["x".repeat(25), "b", "y".repeat(15)], { row: 2, col: 12 }));
    tick();
    resize(10);
    region.release();
    tick();
    expect(writes.at(-1)?.startsWith("\u001b[?2026h\u001b[?25l\u001b[5A\r\u001b[J")).toBe(true);
  });

  it("counts a wide character that does not fit as moving to the next row", () => {
    const { region, writes, tick, resize } = harness(30);
    // 5 wide characters at 5 columns: two to a row, so 3 rows, though 10 cells / 5 would say 2.
    region.set(frame(["가나다라마", "b"], { row: 1, col: 0 }));
    tick();
    resize(5);
    region.release();
    tick();
    expect(writes.at(-1)?.startsWith("\u001b[?2026h\u001b[?25l\u001b[3A\r\u001b[J")).toBe(true);
  });

  it("erases a region folded by a resize when the app exits mid-resize", () => {
    const { region, writes, tick, resize } = harness(30);
    region.set(frame(["x".repeat(25), "b"], { row: 1, col: 0 }));
    tick();
    resize(10);
    region.clear();
    expect(writes.at(-1)).toBe("\u001b[3A\r\u001b[J");
  });

  it("invalidate makes the next paint write the whole region again, though the frame is the same", () => {
    const { region, writes, tick } = harness();
    region.set(frame(["a", "b"], { row: 1, col: 1 }));
    tick();
    region.set(frame(["a", "b"], { row: 1, col: 1 }));
    tick();
    expect(writes).toHaveLength(1);
    region.invalidate();
    tick();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("\u001b[1A\r\u001b[J");
    expect(writes[1]).toContain("a\r\nb");
  });

  describe("untrusted text", () => {
    const OSC_52 = "\u001b]52;c;QUFB\u0007";

    it("drops every control sequence but styling from the live region", () => {
      const { region, writes, tick } = harness(60);
      region.set(
        frame([
          `a${OSC_52}b`,
          "\u001b[2Jcleared\u001b[1;1H",
          "\u001b[31mred\u001b[0m",
          "title\u001b]0;pwn\u001b\\!",
          "c1\u009b2Jx",
        ]),
      );
      tick();
      const text = writes.join("");
      expect(text).not.toContain("\u001b]");
      expect(text).not.toContain("\u0007");
      expect(text).not.toContain("\u001b[2J");
      expect(text).not.toContain("\u001b[1;1H");
      expect(text).not.toContain("\u009b");
      expect(text).toContain("\u001b[31mred\u001b[0m");
      expect(stripAnsi(text)).toContain("ab");
    });

    it("drops them from committed scrollback lines as well", () => {
      const { region, writes, tick } = harness(60);
      region.commit([`done${OSC_52}`, "\u001b[?1049hx"]);
      tick();
      const text = writes.join("");
      expect(text).not.toContain("\u001b]");
      expect(text).not.toContain("\u001b[?1049h");
      expect(stripAnsi(text)).toContain("done");
    });

    it("never lets a line feed inside one frame line move the cursor off its row", () => {
      const { region, writes, tick } = harness(60);
      region.set(frame(["첫째\n둘째", "입력"], { row: 1, col: 0 }));
      tick();
      const painted = writes.join("");
      expect(painted).toContain("첫째 둘째\r\n입력");
    });

    it("splits a committed line that holds a line feed into separate rows", () => {
      const { region, writes, tick } = harness(60);
      region.commit(["가\n나"]);
      tick();
      expect(writes.join("")).toContain("가\u001b[0m\r\n나\u001b[0m\r\n");
    });

    it("clears with the same filter", () => {
      const { region, writes } = harness(60);
      region.commit([`late${OSC_52}`]);
      region.clear();
      expect(writes.join("")).not.toContain("\u001b]");
    });
  });
});

describe("LiveRegion in-place repaint", () => {
  const spinnerFrame = (tick: number) =>
    frame(
      [
        "첫 줄 ".repeat(5),
        "둘째 줄 ".repeat(4),
        `⠋ 작업 ${tick}`,
        "───────".repeat(4),
        "❯ 입력 ".repeat(5),
        "상태줄 ".repeat(5),
      ],
      { row: 4, col: 4 },
    );

  it("rewrites only the row that changed, not the whole region", () => {
    const { region, writes, tick } = harness(40, 20);
    region.set(spinnerFrame(1));
    tick();
    region.set(spinnerFrame(2));
    tick();
    const second = stripAnsi(writes[1] as string);
    expect(second).toContain("⠋ 작업 2");
    for (const untouched of ["첫 줄", "둘째 줄", "───────", "❯ 입력", "상태줄"]) {
      expect(second).not.toContain(untouched);
    }
    expect(writes[1]).not.toContain("\u001b[J");
    // One changed row is a small fraction of the first, full paint.
    expect((writes[1] as string).length).toBeLessThan((writes[0] as string).length / 2);
  });

  it("writes nothing when the next frame is identical to the one on screen", () => {
    const { region, writes, tick } = harness(40, 20);
    region.set(spinnerFrame(1));
    tick();
    region.set(spinnerFrame(1));
    tick();
    expect(writes).toHaveLength(1);
  });

  it("moves only the cursor when only the cursor moved", () => {
    const { region, writes, tick } = harness(40, 20);
    region.set(frame(["a", "❯ 입력"], { row: 1, col: 3 }));
    tick();
    region.set(frame(["a", "❯ 입력"], { row: 1, col: 5 }));
    tick();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toContain("\u001b[5C");
    expect(stripAnsi(writes[1] as string)).not.toContain("입력");
  });

  it("repaints the whole region after the row count changes", () => {
    const { region, writes, tick } = harness(40, 20);
    region.set(frame(["a", "b"], { row: 1, col: 0 }));
    tick();
    region.set(frame(["a", "b", "c"], { row: 2, col: 0 }));
    tick();
    expect(writes[1]).toContain("\u001b[J");
    expect(stripAnsi(writes[1] as string)).toContain("a\r\nb\r\nc");
  });

  it("repaints the whole region after the terminal changed size", () => {
    let columns = 40;
    const writes: string[] = [];
    const pending: Array<() => void> = [];
    const region = new LiveRegion(
      { write: (text) => writes.push(text), columns: () => columns, rows: () => 20 },
      (run) => {
        pending.push(run);
        return () => undefined;
      },
    );
    region.set(frame(["a", "b"]));
    pending.splice(0).forEach((run) => run());
    columns = 30;
    region.set(frame(["a", "c"]));
    pending.splice(0).forEach((run) => run());
    expect(writes[1]).toContain("\u001b[J");
  });

  it("repaints the whole region when scrollback text is committed with it", () => {
    const { region, writes, tick } = harness(40, 20);
    region.set(frame(["a", "b"]));
    tick();
    region.commit(["끝난 줄"]);
    region.set(frame(["a", "c"]));
    tick();
    expect(writes[1]).toContain("\u001b[J");
    expect(stripAnsi(writes[1] as string)).toContain("끝난 줄");
  });

  it("erases the tail of a row that got shorter", () => {
    const { region, writes, tick } = harness(40, 20);
    region.set(frame(["긴 줄입니다 정말로", "b"]));
    tick();
    region.set(frame(["짧음", "b"]));
    tick();
    expect(writes[1]).toContain("짧음");
    expect(writes[1]).toContain("\u001b[K");
  });
});
