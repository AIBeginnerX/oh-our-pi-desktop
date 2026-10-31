import { describe, expect, it } from "vite-plus/test";

import { FakeTerminal } from "../testing/terminal.ts";
import { LiveRegion, type Scheduler } from "./liveRegion.ts";
import { RegionSwitch } from "./regionSwitch.ts";
import { SplitRegion } from "./splitRegion.ts";

const setup = (columns = 120, rows = 24, options: { altScroll?: boolean } = {}) => {
  const term = new FakeTerminal(columns, rows, options);
  const queue: Array<() => void> = [];
  const schedule: Scheduler = (run) => {
    queue.push(run);
    return () => void queue.splice(queue.indexOf(run), 1);
  };
  const out = {
    write: (text: string) => term.write(text),
    columns: () => term.columns,
    rows: () => term.rows,
  };
  const closed: string[] = [];
  const parts: string[] = [];
  const region = new RegionSwitch(
    new LiveRegion(out, schedule),
    new SplitRegion(out, schedule, { divider: () => "|" }),
    out,
    {
      onClosed: (reason, part) => void (closed.push(reason), parts.push(part)),
    },
  );
  const settle = () => queue.splice(0).forEach((run) => run());
  /** What the inline layout shows: the lines said so far, then the live region. */
  const normal = () => term.normalText();
  return { term, region, settle, closed, parts, normal };
};

const frame = (...lines: string[]) => ({ lines, cursor: null });

describe("RegionSwitch", () => {
  it("is the inline region until the split layout is entered", () => {
    const { term, region, settle, normal } = setup();
    region.commit(["첫 줄"]);
    region.set(frame("❯ 입력"));
    settle();
    expect(normal()).toEqual(["첫 줄", "❯ 입력"]);
    expect(term.altScreen).toBe(false);
    expect(region.active()).toBe(false);
    expect(region.usableColumns()).toBe(119);
  });

  it("enters the alternate screen with the live region erased and nothing lost", () => {
    const { term, region, settle, normal } = setup();
    region.commit(["앞의 줄"]);
    region.set(frame("❯ 입력"));
    settle();
    // Said just before entering, never painted: it must still reach the scrollback.
    region.commit(["아직 안 그려진 줄"]);
    region.enter();
    expect(region.active()).toBe(true);
    expect(term.altScreen).toBe(true);
    expect(normal()).toEqual(["앞의 줄", "아직 안 그려진 줄"]);
    region.set(frame("❯ 입력"));
    settle();
    expect(term.screen().join("\n")).toContain("❯ 입력");
    expect(region.usableColumns()).toBeLessThan(119);
  });

  it("sends what was said in the split layout to the scrollback exactly once when it is left", () => {
    const { term, region, settle, normal } = setup();
    region.commit(["A"]);
    region.set(frame("❯"));
    settle();
    region.enter();
    region.set(frame("❯"));
    region.commit(["B", "C"]);
    settle();
    expect(normal()).toEqual(["A"]);
    region.leave();
    region.set(frame("❯ 다시"));
    settle();
    expect(term.altScreen).toBe(false);
    region.commit(["D"]);
    settle();
    expect(normal()).toEqual(["A", "B", "C", "D", "❯ 다시"]);
    // Nothing is said twice if it is left again.
    region.leave();
    settle();
    expect(normal()).toEqual(["A", "B", "C", "D", "❯ 다시"]);
  });

  it("folds the lines it hands back to the width at the time they are written", () => {
    const { term, region, settle, normal } = setup(120, 24);
    region.enter();
    region.commit(["가".repeat(30)]);
    settle();
    term.resize(104, 24);
    region.leave();
    region.set(frame("❯"));
    settle();
    expect(normal().slice(0, -1).join("")).toBe("가".repeat(30));
  });

  it("refuses to enter a terminal narrower than 100 columns", () => {
    const { term, region } = setup(99, 24);
    expect(region.unavailable({ panel: true, tasks: false })).toContain("100칸 미만");
    expect(term.writes).toEqual([]);
  });

  it("closes itself when the terminal shrinks below the limit, and says why", () => {
    const { term, region, settle, closed, normal } = setup(120, 24);
    region.enter();
    region.commit(["대화"]);
    region.set(frame("❯"));
    settle();
    region.hold();
    term.resize(80, 24);
    region.release();
    settle();
    expect(region.active()).toBe(false);
    expect(term.altScreen).toBe(false);
    expect(closed).toHaveLength(1);
    expect(closed[0]).toContain("분리 창을 닫았습니다");
    expect(closed[0]).toContain("80칸");
    expect(normal()).toContain("대화");
  });

  it("folds only the task list when a short terminal still fits the side panel", () => {
    const { term, region, settle, closed, parts } = setup(120, 24);
    region.enter();
    region.setSide(true);
    region.setTasks(["작업 하나", "작업 둘"]);
    region.set(frame("❯"));
    settle();
    region.hold();
    term.resize(120, 14);
    region.release();
    settle();
    expect(region.active()).toBe(true);
    expect(term.altScreen).toBe(true);
    expect(parts).toEqual(["tasks"]);
    expect(closed[0]).toContain("작업 목록");
    expect(term.screen().join("\n")).not.toContain("작업 하나");
  });

  it("closes everything when the task list alone no longer fits", () => {
    const { term, region, settle, parts } = setup(120, 24);
    region.enter();
    region.setSide(false);
    region.setTasks(["작업 하나"]);
    region.set(frame("❯"));
    settle();
    region.hold();
    term.resize(120, 14);
    region.release();
    settle();
    expect(region.active()).toBe(false);
    expect(parts).toEqual(["all"]);
  });

  it("stays open when the terminal is resized and still wide enough", () => {
    const { term, region, settle, closed } = setup(120, 24);
    region.enter();
    region.set(frame("❯"));
    settle();
    region.hold();
    term.resize(140, 30);
    region.release();
    settle();
    expect(region.active()).toBe(true);
    expect(closed).toEqual([]);
    expect(term.altScreen).toBe(true);
  });

  describe("every way out of the program", () => {
    it("clear (a normal exit) leaves the alternate screen and writes the conversation once", () => {
      const { term, region, settle, normal } = setup();
      region.commit(["앞"]);
      region.set(frame("❯"));
      settle();
      region.enter();
      region.commit(["분할 중", "마지막 인사"]);
      settle();
      region.clear();
      expect(term.altScreen).toBe(false);
      expect(normal()).toEqual(["앞", "분할 중", "마지막 인사"]);
    });

    it("restore (the exit event, an exception) does the same synchronously, and only once", () => {
      const { term, region, settle, normal } = setup();
      region.commit(["앞"]);
      region.set(frame("❯"));
      settle();
      region.enter();
      region.set(frame("❯"));
      region.commit(["분할 중"]);
      settle();
      region.restore();
      // No timer is needed: the process is about to be gone.
      expect(term.altScreen).toBe(false);
      expect(normal()).toEqual(["앞", "분할 중"]);
      const writes = term.writes.length;
      region.restore();
      region.restore();
      expect(term.writes.length).toBe(writes);
      expect(normal()).toEqual(["앞", "분할 중"]);
    });

    it("every way out gives the terminal's own alternate scroll setting back", () => {
      for (const original of [true, false]) {
        for (const out of ["clear", "restore", "close", "leave"] as const) {
          const { term, region } = setup(120, 24, { altScroll: original });
          region.enter();
          expect(term.altScroll).toBe(false);
          region[out]();
          expect(term.altScroll, `${out} from ${original}`).toBe(original);
        }
      }
    });

    it("restore does nothing while the inline layout is in use", () => {
      const { term, region, settle } = setup();
      region.set(frame("❯"));
      settle();
      const writes = term.writes.length;
      region.restore();
      expect(term.writes.length).toBe(writes);
    });

    it("restore after a stop, with the layout still suspended, still writes what was said", () => {
      const { region, settle, normal } = setup();
      region.enter();
      region.commit(["말한 것"]);
      settle();
      region.suspend();
      region.restore();
      expect(normal()).toEqual(["말한 것"]);
    });
  });

  describe("after the terminal is handed back", () => {
    // The wait for the server (up to a second and a half) comes after `close`: a request that fails
    // in that time still says so, but it cannot redraw the region over the shell's screen.
    it("writes nothing when something is said late, and the shell cursor stays visible", () => {
      const { term, region, settle, normal } = setup();
      region.commit(["앞"]);
      region.set(frame("❯ 입력"));
      settle();
      region.commit(["└  다음에 또 봐요"]);
      region.close();
      // The terminal is handed back (raw mode off, cursor shown) right after, as `run.ts` does.
      term.write("\u001b[?25h");
      expect(term.cursorVisible).toBe(true);
      const written = term.writes.length;
      region.commit(["목표를 저장하지 못했습니다"]);
      region.set(frame("❯ 다시 그림"));
      region.setPanel(["패널"]);
      region.hold();
      region.release();
      settle();
      region.flush();
      expect(term.writes).toHaveLength(written);
      expect(term.cursorVisible).toBe(true);
      expect(normal()).toEqual(["앞", "└  다음에 또 봐요"]);
    });

    it("drain writes the late lines once, below the farewell, with the cursor shown", () => {
      const { term, region, settle, normal } = setup();
      region.commit(["앞"]);
      region.set(frame("❯ 입력"));
      settle();
      region.commit(["└  다음에 또 봐요"]);
      region.close();
      term.write("\u001b[?25h");
      region.commit(["목표를 저장하지 못했습니다", "두 번째 줄"]);
      region.drain();
      expect(normal()).toEqual([
        "앞",
        "└  다음에 또 봐요",
        "목표를 저장하지 못했습니다",
        "두 번째 줄",
      ]);
      expect(term.cursorVisible).toBe(true);
      const written = term.writes.length;
      region.drain();
      settle();
      expect(term.writes).toHaveLength(written);
    });

    it("drain writes nothing when nothing was said late", () => {
      const { term, region } = setup();
      region.close();
      const written = term.writes.length;
      region.drain();
      expect(term.writes).toHaveLength(written);
    });

    it("leaves the alternate screen first when closed from the side-by-side layout", () => {
      const { term, region, settle, normal } = setup();
      region.enter();
      region.commit(["분할 중"]);
      region.set(frame("❯"));
      settle();
      region.close();
      expect(term.altScreen).toBe(false);
      region.commit(["늦은 줄"]);
      settle();
      region.drain();
      expect(normal()).toEqual(["분할 중", "늦은 줄"]);
      expect(term.cursorVisible).toBe(true);
    });
  });

  describe("Ctrl-Z", () => {
    it("hands the normal screen back while stopped and re-enters the layout when continued", () => {
      const { term, region, settle, normal } = setup();
      region.commit(["앞"]);
      region.set(frame("❯"));
      settle();
      region.enter();
      region.set(frame("❯ 분할"));
      region.commit(["분할 중"]);
      region.setPanel(["패널"]);
      settle();
      region.suspend();
      expect(term.altScreen).toBe(false);
      expect(term.cursorVisible).toBe(true);
      // The shell sees the screen as it was before the layout, with nothing of the conversation yet.
      expect(normal()).toEqual(["앞"]);
      region.resume();
      settle();
      expect(term.altScreen).toBe(true);
      const screen = term.screen().join("\n");
      expect(screen).toContain("분할 중");
      expect(screen).toContain("❯ 분할");
      expect(screen).toContain("패널");
      region.leave();
      region.set(frame("❯"));
      settle();
      expect(normal()).toEqual(["앞", "분할 중", "❯"]);
    });

    it("keeps what is said while stopped in the split, and writes nothing to the shell's screen", () => {
      const { term, region, settle, normal } = setup();
      region.enter();
      region.set(frame("❯"));
      settle();
      region.suspend();
      const written = term.writes.length;
      // A server event arrives while the shell has the terminal.
      region.commit(["멈춘 동안 온 줄"]);
      region.set(frame("❯ 다시"));
      region.setPanel(["패널"]);
      settle();
      expect(term.writes).toHaveLength(written);
      expect(normal()).toEqual([]);
      region.resume();
      settle();
      expect(term.altScreen).toBe(true);
      expect(term.screen().join("\n")).toContain("멈춘 동안 온 줄");
      region.leave();
      region.set(frame("❯"));
      settle();
      expect(normal()).toEqual(["멈춘 동안 온 줄", "❯"]);
    });

    it("hands the conversation to the scrollback when the terminal is too small after a stop", () => {
      const { term, region, settle, closed, normal } = setup();
      region.enter();
      region.commit(["분할에서 한 말"]);
      region.set(frame("❯"));
      settle();
      region.suspend();
      term.resize(80, 24);
      region.resume();
      settle();
      expect(region.active()).toBe(false);
      expect(term.altScreen).toBe(false);
      expect(closed).toHaveLength(1);
      expect(closed[0]).toContain("분리 창을 닫았습니다");
      expect(closed[0]).toContain("지금 80칸");
      expect(normal()).toEqual(["분할에서 한 말"]);
    });

    it("clears the live region when stopped inline, and redraws it whole when continued", () => {
      const { term, region, settle, normal } = setup();
      region.commit(["앞"]);
      region.set(frame("❯ 입력"));
      settle();
      region.suspend();
      expect(normal()).toEqual(["앞"]);
      region.resume();
      // The controller draws its frame again after a continue.
      region.set(frame("❯ 입력"));
      settle();
      expect(term.altScreen).toBe(false);
      expect(normal()).toEqual(["앞", "❯ 입력"]);
    });
  });
});
