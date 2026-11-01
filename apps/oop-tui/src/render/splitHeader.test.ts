import { describe, expect, it } from "vite-plus/test";

import { FakeTerminal } from "../testing/terminal.ts";
import type { Scheduler } from "./liveRegion.ts";
import { SplitRegion, type PinnedHeader } from "./splitRegion.ts";

const setup = (columns = 100, rows = 24) => {
  const term = new FakeTerminal(columns, rows);
  const queue: Array<() => void> = [];
  const schedule: Scheduler = (run) => {
    queue.push(run);
    return () => void queue.splice(queue.indexOf(run), 1);
  };
  const region = new SplitRegion(
    { write: (text) => term.write(text), columns: () => term.columns, rows: () => term.rows },
    schedule,
    { divider: () => "|" },
  );
  const settle = () => queue.splice(0).forEach((run) => run());
  return { term, region, settle };
};

const header = (pet: string): PinnedHeader => ({
  lead: ["LOGO v1 working", "model gpt", "-----"],
  track: [pet.padEnd(12), "            ", "-----------"],
  trackWidth: 12,
});

const many = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);

describe("a pinned header", () => {
  it("stays on the first rows while the conversation scrolls under it", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.setHeader(header("(o_o)"));
    region.commit(many(5));
    region.set({ lines: ["> "], cursor: { row: 0, col: 2 } });
    settle();
    expect(term.screen()[0]).toContain("LOGO v1 working");
    expect(term.screen()[0]).toContain("(o_o)");
    region.commit(many(200));
    settle();
    const screen = term.screen();
    expect(screen[0]).toContain("LOGO v1 working");
    expect(screen[1]).toContain("model gpt");
    expect(screen[3]).toContain("line 19".slice(0, 4));
    expect(screen.join("\n")).toContain("line 199");
    expect(screen.join("\n")).not.toContain("line 5\n");
    region.scrollUp();
    settle();
    expect(term.screen()[0]).toContain("LOGO v1 working");
  });

  it("takes its rows from the conversation, so the live frame still fits above the foot", () => {
    const { region } = setup(100, 24);
    region.enter();
    const before = region.maxRows();
    region.setHeader(header("(o_o)"));
    expect(region.maxRows()).toBe(before - 3);
  });

  it("puts the cursor under the header", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.setHeader(header("(o_o)"));
    region.set({ lines: ["> typed"], cursor: { row: 0, col: 7 } });
    settle();
    expect(term.screen()[23]).toContain("> typed");
  });

  it("rewrites only the pet's strip when the pet moves, and nothing when it did not", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.setHeader(header("(o_o)"));
    region.commit(many(10));
    region.set({ lines: ["> "], cursor: null });
    settle();
    const mark = term.writes.length;
    region.setHeader(header(" (o_o)"));
    settle();
    const moved = term.writes.slice(mark).join("");
    expect(moved).toContain("(o_o)");
    expect(moved).not.toContain("LOGO");
    expect(moved).not.toContain("\u001b[2J");
    expect(moved).not.toContain("line");
    const again = term.writes.length;
    region.setHeader(header(" (o_o)"));
    settle();
    expect(term.writes.length).toBe(again);
  });

  it("is drawn again, whole, when the terminal is resized, and still on top", () => {
    const { term, region, settle } = setup(100, 24);
    region.enter();
    region.setHeader(header("(o_o)"));
    region.commit(many(30));
    settle();
    region.hold();
    term.resize(80, 20);
    region.release();
    settle();
    expect(term.screen()[0]).toContain("LOGO v1 working");
    expect(term.screen()[0]).toContain("(o_o)");
    expect(term.screen().join("\n")).toContain("line 29");
  });

  it("is removed with null, and hands the banner line to the scrollback once on leaving", () => {
    const { term, region, settle } = setup();
    region.enter();
    region.setHeader({ ...header("(o_o)"), scrollback: ["OOP banner", ""] });
    region.commit(["hello"]);
    settle();
    expect(region.leave()).toEqual(["OOP banner", "", "hello"]);
    expect(term.altScreen).toBe(false);
    region.enter();
    region.setHeader(null);
    region.commit(["again"]);
    settle();
    expect(term.screen()[0]).not.toContain("LOGO");
    expect(region.leave()).toEqual(["again"]);
  });
});
