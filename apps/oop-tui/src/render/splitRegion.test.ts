import { describe, expect, it } from "vite-plus/test";

import { FakeTerminal } from "../testing/terminal.ts";
import { stringWidth } from "../text/width.ts";
import type { Scheduler } from "./liveRegion.ts";
import {
  KEEP_LIMIT,
  MOUSE_OFF,
  MOUSE_ON,
  SplitRegion,
  VIEW_LIMIT,
  splitLayout,
  splitUnavailable,
} from "./splitRegion.ts";

const setup = (
  columns = 100,
  rows = 24,
  options: {
    altScroll?: boolean;
    divider?: string;
    repeat?: (run: () => void) => () => void;
  } = {},
) => {
  const divider = options.divider ?? "|";
  const term = new FakeTerminal(columns, rows, options);
  const queue: Array<() => void> = [];
  const schedule: Scheduler = (run) => {
    queue.push(run);
    return () => void queue.splice(queue.indexOf(run), 1);
  };
  const region = new SplitRegion(
    { write: (text) => term.write(text), columns: () => term.columns, rows: () => term.rows },
    schedule,
    { divider: () => divider, ...(options.repeat ? { repeat: options.repeat } : {}) },
  );
  /** Runs the paint a timer would. */
  const settle = () => queue.splice(0).forEach((run) => run());
  return { term, region, settle, queued: () => queue.length };
};

const frameOf = (...lines: string[]) => ({ lines, cursor: null });

describe("the split layout", () => {
  it("puts the divider between a conversation column and a panel, with the last column free", () => {
    const { left, panel } = splitLayout(100);
    expect(left + 1 + panel + 1).toBe(100);
    expect(panel).toBe(38);
    expect(splitLayout(300).panel).toBe(72);
    expect(splitLayout(100).left).toBeGreaterThan(splitLayout(100).panel);
  });

  it("refuses a terminal that is too narrow or too short, with the reason", () => {
    expect(splitUnavailable(100, 12)).toBeNull();
    expect(splitUnavailable(99, 30)).toContain("100칸 미만");
    expect(splitUnavailable(99, 30)).toContain("지금 99칸");
    expect(splitUnavailable(120, 11)).toContain("12줄 미만");
  });
});

describe("SplitRegion", () => {
  it("enters the alternate screen with the cursor hidden and draws the whole screen on the first paint", () => {
    const { term, region, settle } = setup();
    region.enter();
    expect(term.altScreen).toBe(true);
    expect(term.cursorVisible).toBe(false);
    region.set(frameOf("❯ 입력"));
    region.setPanel(["Workflow", "", "내용"]);
    settle();
    const { left } = splitLayout(100);
    expect(term.text(23, 0, left)).toContain("❯ 입력");
    expect(term.text(0, left + 1)).toBe("Workflow");
    expect(term.text(2, left + 1)).toBe("내용");
    // The divider runs the whole height.
    for (let row = 0; row < 24; row += 1) expect(term.cell(row, left)).toBe("|");
  });

  it("writes nothing for a frame that is the same as the one on screen", () => {
    const { term, region, settle, queued } = setup();
    region.enter();
    region.set(frameOf("❯ 입력"));
    region.setPanel(["a"]);
    settle();
    const before = term.writes.length;
    region.set(frameOf("❯ 입력"));
    region.setPanel(["a"]);
    // The same panel does not even ask for a paint; the same frame is found equal when it does.
    settle();
    expect(term.writes.length).toBe(before);
    expect(queued()).toBe(0);
  });

  it("rewrites only the row that changed, and only its side", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.set(frameOf("❯ 입력", "상태 줄"));
    region.setPanel(["panel-a", "panel-b"]);
    settle();
    const base = term.writes.length;
    region.set(frameOf("❯ 입력", "상태 줄 2"));
    settle();
    const written = term.writes.slice(base).join("");
    expect(written).toContain("상태 줄 2");
    expect(written).not.toContain("입력");
    expect(written).not.toContain("panel");
    expect(written).not.toContain("\u001b[2J");
    region.setPanel(["panel-a", "panel-c"]);
    const second = term.writes.length;
    settle();
    const panelWrite = term.writes.slice(second).join("");
    expect(panelWrite).toContain("panel-c");
    expect(panelWrite).not.toContain("panel-a");
    expect(panelWrite).not.toContain("상태");
  });

  it("puts the cursor in the composer, hidden when the frame has none", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.set({ lines: ["위", "❯ 입력"], cursor: { row: 1, col: 4 } });
    settle();
    expect(term.cursor).toEqual({ row: 23, col: 4 });
    expect(term.cursorVisible).toBe(true);
    region.set({ lines: ["위", "목록"], cursor: null });
    settle();
    expect(term.cursorVisible).toBe(false);
  });

  it("never lets a wide character cross the divider or the edge of the panel", () => {
    for (const columns of [100, 101, 133]) {
      const { term, region, settle } = setup(columns);
      const { left, panel } = splitLayout(columns);
      region.enter();
      region.set(frameOf("가".repeat(80), "ab" + "나".repeat(60)));
      region.setPanel(["다".repeat(50), "x" + "라".repeat(50)]);
      settle();
      for (let row = 0; row < 24; row += 1) {
        expect(term.cell(row, left)).toBe("|");
        // The gutter cell before the divider and the last column stay empty.
        expect(term.cell(row, left - 1).trim()).toBe("");
        expect(term.text(row, left + 1 + panel).trim()).toBe("");
        expect(stringWidth(term.text(row, left + 1))).toBeLessThanOrEqual(panel);
      }
    }
  });

  it("shows committed lines above the live frame, newest at the bottom, folded to the column", () => {
    const { term, region, settle } = setup(100, 12);
    region.enter();
    region.commit(["첫째", "둘째"]);
    region.commit(["가".repeat(100)]);
    region.set(frameOf("❯ 입력"));
    settle();
    const { left } = splitLayout(100);
    expect(term.text(11, 0, left)).toContain("❯ 입력");
    const rows = Array.from({ length: 11 }, (_, row) => term.text(row, 0, left));
    // Blank rows on top, then the lines in order; the long line was folded to the column.
    const shown = rows.filter((row) => row !== "");
    expect(shown[0]).toBe("첫째");
    expect(shown[1]).toBe("둘째");
    expect(shown.slice(2).join("")).toBe("가".repeat(100));
    expect(shown.length).toBeGreaterThan(3);
    expect(Math.max(...shown.map(stringWidth))).toBeLessThan(left);
  });

  it("folds the conversation again at the new width after a resize", () => {
    const { term, region, settle } = setup(120, 12);
    region.enter();
    region.commit(["가나다라마바사아자차카타파하".repeat(4)]);
    region.set(frameOf("❯"));
    settle();
    const wide = term.screen().filter((row) => row.includes("가나다")).length;
    region.hold();
    term.resize(100, 12);
    region.release();
    settle();
    const narrow = term
      .screen()
      .filter((row) => row.includes("가나다") || row.includes("카타파")).length;
    expect(narrow).toBeGreaterThanOrEqual(wide);
    const joined = Array.from({ length: 11 }, (_, row) =>
      term.text(row, 0, splitLayout(100).left),
    ).join("");
    expect(joined).toBe("가나다라마바사아자차카타파하".repeat(4));
  });

  it("paints nothing while a resize is held, and everything once it settles", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.set(frameOf("❯ 입력"));
    settle();
    region.hold();
    region.set(frameOf("❯ 바뀐 입력"));
    settle();
    const before = term.writes.length;
    settle();
    expect(term.writes.length).toBe(before);
    term.resize(110, 30);
    region.release();
    settle();
    expect(term.screen()[29]).toContain("❯ 바뀐 입력");
    expect(term.cell(0, splitLayout(110).left)).toBe("|");
  });

  it("paints everything again when invalidated", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.set(frameOf("❯ 입력"));
    settle();
    const before = term.writes.length;
    region.invalidate();
    settle();
    expect(term.writes.slice(before).join("")).toContain("\u001b[2J");
    expect(term.screen()[23]).toContain("❯ 입력");
  });

  it("hands back every committed line, once and in order, when it is left", () => {
    const { term, region } = setup();
    region.enter();
    region.commit(["하나", "둘\n셋"]);
    region.commit(["넷"]);
    const lines = region.leave();
    expect(lines).toEqual(["하나", "둘", "셋", "넷"]);
    expect(term.altScreen).toBe(false);
    expect(term.cursorVisible).toBe(true);
    // Nothing is kept, so a second leave hands back nothing.
    expect(region.leave()).toEqual([]);
  });

  it("keeps lines scrolled away with Ctrl-L for the scrollback, but not in the viewport", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.commit(["지워질 줄"]);
    region.set(frameOf("❯"));
    settle();
    expect(term.screen().join("\n")).toContain("지워질 줄");
    region.abandon();
    settle();
    expect(term.screen().join("\n")).not.toContain("지워질 줄");
    region.commit(["새 줄"]);
    settle();
    expect(term.screen().join("\n")).toContain("새 줄");
    expect(region.leave()).toEqual(["지워질 줄", "새 줄"]);
  });

  it("hands back the newest lines when more than it keeps were said, with a line that counts the rest", () => {
    const { region } = setup();
    region.enter();
    region.commit(Array.from({ length: KEEP_LIMIT + 50 }, (_, index) => `줄 ${index}`));
    const lines = region.leave();
    expect(lines).toHaveLength(KEEP_LIMIT + 1);
    expect(lines[0]).toBe("… 분할 중 50줄 생략");
    expect(lines[1]).toBe("줄 50");
    expect(lines.at(-1)).toBe(`줄 ${KEEP_LIMIT + 49}`);
    // The count starts over for the next time.
    region.enter();
    region.commit(["하나"]);
    expect(region.leave()).toEqual(["하나"]);
  });

  it("keeps more for the scrollback than the viewport can scroll back over", () => {
    expect(KEEP_LIMIT).toBeGreaterThan(VIEW_LIMIT);
    const { term, region, settle } = setup(100, 24);
    region.enter();
    region.commit(Array.from({ length: VIEW_LIMIT + 100 }, (_, index) => `줄 ${index}`));
    region.set(frameOf("❯"));
    settle();
    // Scrolling stops at the oldest line the viewport holds, not at the oldest one kept.
    for (let press = 0; press < 400; press += 1) region.scrollUp();
    const shown = term.screen().join("\n");
    expect(shown).toContain("줄 100");
    expect(shown).not.toContain("줄 99\n");
    expect(region.leave()).toHaveLength(VIEW_LIMIT + 100);
  });

  it("turns alternate scroll off while on and gives the user's own setting back, also when stopped", () => {
    for (const original of [true, false]) {
      const { term, region } = setup(100, 24, { altScroll: original });
      region.enter();
      expect(term.altScroll).toBe(false);
      region.suspend();
      expect(term.altScroll).toBe(original);
      region.resume();
      expect(term.altScroll).toBe(false);
      region.leave();
      expect(term.altScroll).toBe(original);
    }
  });

  it("gives back a terminal with alternate scroll off as it found it", () => {
    const { term, region } = setup(100, 24, { altScroll: false });
    region.enter();
    region.suspend();
    region.resume();
    region.leave();
    expect(term.altScroll).toBe(false);
  });

  it("does not leave alternate scroll off on a terminal that cannot restore it", () => {
    const { term, region } = setup(100, 24, { altScroll: true });
    region.enter();
    expect(term.altScroll).toBe(false);
    const written = term.writes.join("").length;
    region.leave();
    const leaving = term.writes.join("").slice(written);
    expect(leaving.indexOf("\u001b[?1007h")).toBeLessThan(leaving.indexOf("\u001b[?1007r"));
    expect(leaving).toContain("\u001b[?1007h");
  });

  describe("scrolling the conversation", () => {
    const lines = Array.from({ length: 100 }, (_, index) => `줄 ${index}`);
    const started = () => {
      const kit = setup(100, 24);
      kit.region.enter();
      kit.region.commit(lines);
      kit.region.set(frameOf("❯"));
      kit.settle();
      return kit;
    };
    const SCROLLING = "↑ 스크롤 중";

    it("shows older lines a page at a time and says so on one row", () => {
      const { term, region } = started();
      expect(term.screen().join("\n")).not.toContain(SCROLLING);
      expect(term.text(22, 0, 20)).toContain("줄 99");
      region.scrollUp();
      const left = term.screen().map((row) => row.slice(0, splitLayout(100).left));
      expect(left.filter((row) => row.includes(SCROLLING))).toHaveLength(1);
      // One page up: the newest line is gone, and an older one is on screen.
      expect(left.join("\n")).not.toContain("줄 99");
      expect(left.join("\n")).toContain("줄 76");
      // The composer stays where it was.
      expect(term.text(23, 0, 20)).toContain("❯");
    });

    it("names the keys that go back down", () => {
      const { term, region } = started();
      region.scrollUp();
      expect(term.screen().join("\n")).toContain("PageDown");
      expect(term.screen().join("\n")).toContain("End");
    });

    it("follows again when PageDown reaches the bottom", () => {
      const { term, region, settle } = started();
      region.scrollUp();
      region.scrollUp();
      region.scrollDown();
      settle();
      expect(term.screen().join("\n")).toContain(SCROLLING);
      region.scrollDown();
      settle();
      expect(term.screen().join("\n")).not.toContain(SCROLLING);
      expect(term.screen().join("\n")).toContain("줄 99");
    });

    it("stops at the oldest line instead of scrolling into blank rows", () => {
      const { term, region } = started();
      for (let press = 0; press < 20; press += 1) region.scrollUp();
      expect(term.text(0, 0, 10)).toContain("줄 0");
    });

    it("follows on new input", () => {
      const { term, region, settle } = started();
      region.scrollUp();
      region.follow();
      settle();
      expect(term.screen().join("\n")).not.toContain(SCROLLING);
      expect(term.screen().join("\n")).toContain("줄 99");
    });

    it("keeps the page in place when new lines arrive while it is scrolled back", () => {
      const { term, region, settle } = started();
      region.scrollUp();
      const before = term.screen().map((row) => row.slice(0, 20));
      region.commit(["새로 온 줄", "또 온 줄"]);
      settle();
      const after = term.screen().map((row) => row.slice(0, 20));
      expect(after.slice(0, 22)).toEqual(before.slice(0, 22));
      expect(after.join("\n")).not.toContain("새로 온 줄");
      // Following again shows them.
      region.follow();
      settle();
      expect(term.screen().join("\n")).toContain("또 온 줄");
    });

    it("does nothing when it is not on", () => {
      const { term, region, settle } = setup();
      region.scrollUp();
      region.scrollDown();
      region.follow();
      settle();
      expect(term.writes).toEqual([]);
    });
  });

  it("cleans control sequences out of the lines it keeps and draws", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.commit(["\u001b]0;제목\u0007안전\u001b[2J줄"]);
    region.set(frameOf("❯"));
    region.setPanel(["\u001b[2J패널"]);
    settle();
    expect(term.screen().join("\n")).toContain("안전줄");
    expect(term.screen().join("\n")).toContain("패널");
    expect(region.leave()).toEqual(["안전줄"]);
  });

  it("leaves the alternate screen when stopped and returns to it, with the conversation, when continued", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.commit(["말한 내용"]);
    region.set(frameOf("❯"));
    settle();
    region.suspend();
    expect(term.altScreen).toBe(false);
    expect(term.cursorVisible).toBe(true);
    expect(region.isSuspended()).toBe(true);
    region.resume();
    settle();
    expect(term.altScreen).toBe(true);
    expect(term.screen().join("\n")).toContain("말한 내용");
    expect(region.leave()).toEqual(["말한 내용"]);
  });

  it("limits the live frame so a few rows of conversation always stay above it", () => {
    const { region } = setup(100, 20);
    expect(region.maxRows()).toBe(17);
    expect(region.usableColumns()).toBe(splitLayout(100).left - 1);
    expect(region.panelSize()).toEqual({ columns: splitLayout(100).panel, rows: 20 });
  });

  it("draws nothing when it is not on", () => {
    const { term, region, settle, queued } = setup();
    region.set(frameOf("❯"));
    region.commit(["x"]);
    settle();
    expect(queued()).toBe(0);
    expect(term.writes).toEqual([]);
  });
});

describe("SplitRegion mouse wheel and older lines", () => {
  const ON = "\u001b[?1000h\u001b[?1006h";
  const OFF = "\u001b[?1006l\u001b[?1000l";
  const lines = Array.from({ length: 100 }, (_, index) => `줄 ${index}`);
  const started = () => {
    const kit = setup(100, 24);
    kit.region.enter();
    kit.region.commit(lines);
    kit.region.set(frameOf("❯"));
    kit.settle();
    return kit;
  };

  it("asks for SGR wheel reports on entry and gives them back on every way out", () => {
    for (const leave of ["leave", "suspend"] as const) {
      const { term, region } = setup();
      region.enter();
      expect(term.writes.join("")).toContain(ON);
      term.writes.length = 0;
      region[leave]();
      expect(term.writes.join("")).toContain(OFF);
      // The report is switched off before the normal screen comes back.
      expect(term.writes.join("").indexOf(OFF)).toBeLessThan(
        term.writes.join("").indexOf("\u001b[?1049l"),
      );
    }
  });

  it("does not ask for reports when the option is off, and follows /mouse while on", () => {
    const term = new FakeTerminal(100, 24);
    const region = new SplitRegion(
      { write: (text) => term.write(text), columns: () => term.columns, rows: () => term.rows },
      () => () => {},
      { divider: () => "|", mouse: false },
    );
    region.enter();
    expect(term.writes.join("")).not.toContain(ON);
    region.setMouse(true);
    expect(term.writes.join("")).toContain(ON);
    region.setMouse(false);
    expect(term.writes.join("")).toContain(OFF);
    expect(region.mouseOn()).toBe(false);
  });

  it("scrolls back by rows and returns to following at the bottom", () => {
    const { term, region, settle } = started();
    region.scrollBy(3);
    settle();
    expect(region.isScrolled()).toBe(true);
    expect(term.screen().join("\n")).not.toContain("줄 99");
    region.scrollBy(-1000);
    settle();
    expect(region.isScrolled()).toBe(false);
    expect(term.screen().join("\n")).toContain("줄 99");
  });

  it("says new messages are below when lines arrive while scrolled back, and clears it at the bottom", () => {
    const { term, region, settle } = started();
    region.scrollBy(10);
    settle();
    expect(term.screen().join("\n")).toContain("↑ 스크롤 중");
    region.commit(["새 메시지"]);
    settle();
    expect(term.screen().join("\n")).toContain("아래에 새 메시지");
    region.scrollBottom();
    settle();
    expect(term.screen().join("\n")).not.toContain("아래에 새 메시지");
    expect(term.screen().join("\n")).toContain("새 메시지");
  });

  it("follows the bottom while streaming when it was not scrolled back", () => {
    const { term, region, settle } = started();
    region.commit(["스트림 1", "스트림 2"]);
    settle();
    expect(term.screen().join("\n")).toContain("스트림 2");
    expect(region.isScrolled()).toBe(false);
  });

  it("Home goes to the oldest line and End back to the newest", () => {
    const { term, region, settle } = started();
    region.scrollTop();
    settle();
    expect(term.text(0, 0, 10)).toContain("줄 0");
    region.scrollBottom();
    settle();
    expect(term.screen().join("\n")).toContain("줄 99");
  });

  it("asks for older lines once the top is reached, and keeps the reader's place when they arrive", () => {
    const { term, region, settle } = started();
    let asked = 0;
    region.onOlder(() => {
      asked += 1;
    });
    region.scrollBy(2);
    settle();
    expect(asked).toBe(0);
    region.scrollTop();
    settle();
    settle();
    expect(asked).toBeGreaterThan(0);
    const before = term.text(0, 0, 10);
    region.prepend(["더 오래된 줄 A", "더 오래된 줄 B"]);
    settle();
    expect(term.text(0, 0, 10)).toBe(before);
    expect(region.leave()[0]).toContain("더 오래된 줄 A");
  });

  it("keeps memory bounded: the oldest lines are dropped past the keep limit", () => {
    const { region } = setup();
    region.enter();
    region.commit(Array.from({ length: KEEP_LIMIT + 50 }, (_, index) => `줄 ${index}`));
    const kept = region.leave();
    expect(kept).toHaveLength(KEEP_LIMIT + 1);
    expect(kept[1]).toBe("줄 50");
  });

  it("ignores the wheel when it is not on", () => {
    const { term, region, settle } = setup();
    region.scrollBy(5);
    region.scrollTop();
    settle();
    expect(term.writes).toEqual([]);
  });
});

describe("SplitRegion selecting text with the mouse", () => {
  const REVERSE = "\u001b[7m";
  /** A terminal cell as the mouse reports it: 1-based. */
  const at = (row: number, col: number) => [col + 1, row + 1] as const;
  const lines = ["첫째 줄", "둘째 줄", "셋째 줄"];
  /** 100 columns by 24 rows: the conversation is rows 0-22, 59 columns wide, the panel starts at column 61. */
  const started = (options: Parameters<typeof setup>[2] = {}, history: string[] = lines) => {
    const kit = setup(100, 24, options);
    kit.region.enter();
    kit.region.commit(history);
    kit.region.set(frameOf("❯"));
    kit.settle();
    return kit;
  };
  const written = (term: FakeTerminal) => term.writes.join("");

  it("asks for button-drag reports after the wheel's, and gives them all back, before the normal screen", () => {
    expect(MOUSE_ON.indexOf("?1000h")).toBeLessThan(MOUSE_ON.indexOf("?1002h"));
    expect(MOUSE_ON).toContain("?1006h");
    for (const mode of ["?1000", "?1002", "?1006"]) expect(MOUSE_OFF).toContain(`${mode}l`);
    const { term, region } = setup();
    region.enter();
    expect(written(term)).toContain(MOUSE_ON);
    term.writes.length = 0;
    region.leave();
    expect(written(term).indexOf(MOUSE_OFF)).toBeLessThan(written(term).indexOf("\u001b[?1049l"));
  });

  it("selects from the press to the release and hands the plain text back on release", () => {
    const { region, term, settle } = started();
    region.selectStart(...at(20, 0));
    region.selectMove(...at(21, 1));
    region.selectMove(...at(22, 2));
    settle();
    // The highlight is on screen, and the text is unchanged by it.
    expect(written(term)).toContain(REVERSE);
    expect(term.text(20, 0, 6)).toBe("첫째 줄");
    // The third row is cut in the middle of 째 (columns 2 and 3): the glyph is taken whole.
    expect(region.selectEnd(...at(22, 2))).toBe("첫째 줄\n둘째 줄\n셋째");
  });

  it("selects backwards as well as forwards", () => {
    const { region } = started();
    region.selectStart(...at(22, 3));
    region.selectMove(...at(20, 0));
    expect(region.selectEnd(...at(20, 0))).toBe("첫째 줄\n둘째 줄\n셋째");
  });

  it("takes a Korean syllable whole whichever of its two cells the pointer is on", () => {
    const { region } = started();
    region.selectStart(...at(20, 1));
    region.selectMove(...at(20, 2));
    expect(region.selectEnd(...at(20, 2))).toBe("첫째");
  });

  it("copies nothing for a plain click, and clears what was selected before", () => {
    const { region, term, settle } = started();
    region.selectStart(...at(20, 0));
    region.selectMove(...at(21, 2));
    region.selectEnd(...at(21, 2));
    settle();
    expect(region.selecting()).toBe(true);
    term.writes.length = 0;
    region.selectStart(...at(21, 5));
    expect(region.selectEnd(...at(21, 5))).toBeNull();
    settle();
    expect(region.selecting()).toBe(false);
    // The rows that were highlighted are drawn again without it.
    expect(written(term)).not.toContain(REVERSE);
  });

  it("copies nothing for a drag that came back to where it began", () => {
    const { region } = started();
    region.selectStart(...at(21, 3));
    region.selectMove(...at(21, 5));
    region.selectMove(...at(21, 3));
    expect(region.selectEnd(...at(21, 3))).toBeNull();
  });

  it("ignores a press on the side panel, the live frame and the blank rows above the text", () => {
    for (const [row, col] of [
      [21, 70],
      [23, 1],
      [3, 1],
    ] as const) {
      const { region } = started();
      region.selectStart(...at(row, col));
      region.selectMove(...at(22, 3));
      expect(region.selectEnd(...at(22, 3)), `${row},${col}`).toBeNull();
      expect(region.selecting()).toBe(false);
    }
  });

  it("does not follow the pointer into the panel: the selection ends at the end of the row", () => {
    const { region } = started();
    region.selectStart(...at(20, 0));
    region.selectMove(...at(21, 80));
    expect(region.selectEnd(...at(21, 80))).toBe("첫째 줄\n둘째 줄");
  });

  it("stays out of the header", () => {
    const { term, region, settle } = setup(100, 24);
    region.enter();
    region.setHeader({ lead: ["OOP", "상태"], track: [], trackWidth: 0 });
    region.commit(lines);
    region.set(frameOf("❯"));
    settle();
    // Rows 0-1 are the header; the conversation's last line is at row 22.
    expect(term.text(0, 0, 3)).toBe("OOP");
    region.selectStart(...at(0, 1));
    expect(region.selectEnd(...at(22, 3))).toBeNull();
    // Dragging up into the header from the text stops at the first line instead.
    region.selectStart(...at(22, 0));
    region.selectMove(...at(0, 1));
    expect(region.selectEnd(...at(0, 1))).toBe("첫째 줄\n둘째 줄\n셋");
  });

  it("joins the rows a long line is folded into, with its spaces back", () => {
    const sentence = Array.from({ length: 30 }, (_, n) => `word${n}`).join(" ");
    const { region, term } = started({}, [`│  ${sentence}`, "│  끝"]);
    // The line is folded to 59 columns: at least three rows, then the last line.
    expect(term.text(22, 0, 8)).toBe("│  끝");
    region.selectStart(...at(18, 0));
    region.selectMove(...at(22, 10));
    expect(region.selectEnd(...at(22, 10))).toBe(`${sentence}\n끝`);
  });

  it("scrolls toward the edge the pointer is held past, and the selection follows", () => {
    const history = Array.from({ length: 100 }, (_, n) => `줄 ${n}`);
    let tick: () => void = () => undefined;
    let stopped = 0;
    const { region, settle } = started(
      {
        repeat: (run) => {
          tick = run;
          return () => void (stopped += 1);
        },
      },
      history,
    );
    // The viewport shows 줄 77-줄 99; the press is on 줄 87.
    region.selectStart(...at(10, 0));
    region.selectMove(...at(0, 0));
    region.selectMove(...at(-1, 0));
    for (let n = 0; n < 3; n += 1) tick();
    settle();
    expect(region.isScrolled()).toBe(true);
    // The pointer is above the first row; the button comes up there.
    const text = region.selectEnd(...at(-1, 0)) as string;
    expect(stopped).toBe(1);
    const rows = text.split("\n");
    // One row at the first move past the edge, one more for each of the three ticks.
    expect(rows[0]).toBe("줄 73");
    expect(rows.at(-1)).toBe("줄");
    expect(rows).toHaveLength(87 - 73 + 1);
  });

  it("scrolls back down when held past the bottom edge", () => {
    const history = Array.from({ length: 100 }, (_, n) => `줄 ${n}`);
    const { region, settle } = started({}, history);
    region.scrollBy(10);
    settle();
    region.selectStart(...at(5, 0));
    region.selectMove(...at(23, 0));
    settle();
    expect(region.isScrolled()).toBe(true);
    for (let n = 0; n < 10; n += 1) region.selectMove(...at(23, 0));
    settle();
    expect(region.isScrolled()).toBe(false);
  });

  it("keeps the selection on its text while the view scrolls and lines arrive", () => {
    const { region, term, settle } = started();
    region.selectStart(...at(21, 0));
    region.selectMove(...at(21, 3));
    region.selectEnd(...at(21, 3));
    settle();
    term.writes.length = 0;
    region.commit(["넷째 줄"]);
    settle();
    // 둘째 줄 moved up a row and is still highlighted there.
    expect(term.text(20, 0, 6)).toBe("둘째 줄");
    expect(written(term)).toContain(REVERSE);
    region.selectStart(...at(0, 0));
    expect(region.selectEnd(...at(0, 0))).toBeNull();
  });

  it("is cleared by leaving, suspending, turning the mouse off and folding to another width", () => {
    const select = (kit: ReturnType<typeof started>) => {
      kit.region.selectStart(...at(20, 0));
      kit.region.selectMove(...at(21, 3));
      kit.region.selectEnd(...at(21, 3));
      expect(kit.region.selecting()).toBe(true);
    };
    for (const end of [
      (kit: ReturnType<typeof started>) => kit.region.leave(),
      (kit: ReturnType<typeof started>) => kit.region.suspend(),
      (kit: ReturnType<typeof started>) => kit.region.setMouse(false),
      (kit: ReturnType<typeof started>) => kit.region.abandon(),
      (kit: ReturnType<typeof started>) => {
        kit.term.resize(120, 24);
        kit.region.invalidate();
        kit.settle();
      },
    ]) {
      const kit = started();
      select(kit);
      end(kit);
      expect(kit.region.selecting()).toBe(false);
    }
  });

  it("copies a user's boxed message as its text alone, never the border of the box", () => {
    // The box the renderer draws for a short message in a 58-column conversation: a top edge, one row
    // of text and a bottom edge, against the right edge. The viewport shows them on rows 20 to 22.
    const lead = " ".repeat(58 - 8);
    const box = [`${lead}╭──────╮`, `${lead}│ 안녕 │`, `${lead}╰──────╯`];
    const { region } = started({}, box);
    // Select the whole box, from the left of its first row to the right of its last.
    region.selectStart(...at(20, 0));
    region.selectMove(...at(22, 57));
    expect(region.selectEnd(...at(22, 57))).toBe("안녕");
    // And a drag that covers only the text, border cells included, takes the text alone.
    region.selectStart(...at(21, 50));
    region.selectMove(...at(21, 57));
    expect(region.selectEnd(...at(21, 57))).toBe("안녕");
    // The edges alone hold nothing of the message, so there is nothing to copy.
    region.selectStart(...at(20, 51));
    region.selectMove(...at(20, 57));
    expect(region.selectEnd(...at(20, 57))).toBeNull();
  });

  it("does nothing when the layout is not on", () => {
    const { region, term } = setup();
    region.selectStart(5, 5);
    expect(region.selectEnd(5, 5)).toBeNull();
    expect(term.writes).toEqual([]);
  });
});
