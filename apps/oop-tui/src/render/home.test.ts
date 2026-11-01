import { describe, expect, it, vi } from "vite-plus/test";

import type { ReleaseView, UpdateReport } from "../app/updateCheck.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import { composeHome, fitHome, homeNaturalRows, type HomeInput } from "./home.ts";
import { LiveRegion } from "./liveRegion.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const host = vi.hoisted(() => ({ platform: null as NodeJS.Platform | null }));
vi.mock("../host.ts", async (original) => {
  const actual = await original<typeof import("../host.ts")>();
  return { ...actual, hostPlatform: () => host.platform ?? actual.hostPlatform() };
});

const release = (version: string, ...highlights: string[]): ReleaseView => ({
  version,
  date: "2026-11-01",
  highlights,
});

const UPDATE: UpdateReport = {
  status: "update",
  current: "0.0.127",
  latest: "0.0.130",
  releases: [
    release("0.0.130", "가 핵심", "나 핵심"),
    release("0.0.129", "다 핵심"),
    release("0.0.128", "라 핵심", "마 핵심", "바 핵심"),
  ],
};

const input = (extra: Partial<HomeInput> = {}): HomeInput => ({
  columns: 100,
  theme: createTheme("oop", BUILTIN_THEMES.oop, 3),
  symbols: UNICODE_SYMBOLS,
  banner: { version: "0.0.127", server: "127.0.0.1:3773", cwd: "/home/me/app", home: "/home/me" },
  report: UPDATE,
  versions: { terminal: "0.0.127", app: "0.0.127" },
  ...extra,
});

const plain = (lines: ReadonlyArray<string>) => lines.map(stripAnsi);

describe("fitHome", () => {
  it("puts the wordmark first and the notice under it, release by release, newest first", () => {
    const rows = plain(fitHome(input(), 40));
    expect(rows[0]).toMatch(/[█▄▀]/u);
    const header = rows.findIndex((row) => row.includes("업데이트 있음: 0.0.127 → 0.0.130"));
    expect(header).toBeGreaterThan(3);
    const order = ["0.0.130", "0.0.129", "0.0.128"].map((version) =>
      rows.findIndex((row) => row.includes(`${version} 2026-11-01`)),
    );
    expect(order).toEqual([...order].toSorted((a, b) => a - b));
    expect(order.every((index) => index > header)).toBe(true);
    expect(rows.join("\n")).toContain("가 핵심");
    expect(rows.join("\n")).toContain("바 핵심");
  });

  it("ends with the number of releases left out when they do not all fit", () => {
    const many: UpdateReport = {
      ...UPDATE,
      releases: ["0.0.134", "0.0.133", "0.0.132", "0.0.131", "0.0.130"].map((v) =>
        release(v, `핵심 ${v}`),
      ),
    };
    const rows = plain(fitHome(input({ report: many }), 40));
    expect(rows.filter((row) => row.includes("2026-11-01"))).toHaveLength(3);
    expect(rows.at(-1)).toBe("  외 2개 릴리스 — /update");
  });

  it("gives up releases before it gives up the headline, and never exceeds the budget", () => {
    for (let budget = 0; budget <= 30; budget += 1) {
      const rows = plain(fitHome(input(), budget));
      expect(rows.length, `budget ${budget}`).toBeLessThanOrEqual(budget);
      if (budget >= 1) expect(rows.join("\n"), `budget ${budget}`).toContain("업데이트 있음");
    }
    expect(plain(fitHome(input({ banner: null }), 3))).toEqual([
      "◆ 업데이트 있음: 0.0.127 → 0.0.130",
      "  업데이트 방법: 앱 메뉴 '업데이트 확인...' → '업데이트 준비' → '설치 프로그램 열기'",
      "  릴리스 3개 — /update",
    ]);
  });

  it("makes the wordmark one line, then none, before it takes the notice's room", () => {
    expect(plain(fitHome(input(), 8))[0]).toMatch(/[█▄▀]/u);
    const compact = plain(fitHome(input(), 7));
    expect(compact[0]).toBe("◆ OOP v0.0.127");
    expect(compact).toHaveLength(7);
    const none = plain(fitHome(input(), 2));
    expect(none.join("\n")).not.toContain("OOP v");
  });

  it("is only the notice without a wordmark when the banner is off", () => {
    const rows = plain(fitHome(input({ banner: null }), 40));
    expect(rows[0]).toContain("업데이트 있음");
    expect(rows.join("\n")).not.toMatch(/[█▄▀]/u);
  });

  it("is quiet: a current app gets one dim line, no answer gets nothing", () => {
    const current: UpdateReport = {
      status: "current",
      current: "0.0.127",
      latest: "0.0.127",
      releases: [],
    };
    expect(plain(fitHome(input({ banner: null, report: current }), 10))).toEqual([
      "✓ 최신 버전입니다 (0.0.127)",
    ]);
    expect(fitHome(input({ banner: null, report: null }), 10)).toEqual([]);
  });

  it("adds the reinstall line only when the terminal app is older than the app", () => {
    host.platform = "darwin";
    const behind = plain(
      fitHome(input({ banner: null, versions: { terminal: "0.0.120", app: "0.0.127" } }), 10),
    );
    host.platform = null;
    expect(behind.join("\n")).toContain("터미널 앱 0.0.120 이 앱 0.0.127 보다 오래되었습니다");
    expect(behind.join("\n")).toContain("install-desktop.sh");
    expect(behind.join("\n")).not.toContain("apps/oop-tui/install.sh");
    const same = plain(fitHome(input({ banner: null }), 10)).join("\n");
    expect(same).not.toContain("터미널 앱");
    const unknown = plain(
      fitHome(input({ banner: null, versions: { terminal: "0.0.120", app: null } }), 10),
    ).join("\n");
    expect(unknown).not.toContain("터미널 앱");
  });

  it("keeps the reinstall line when the room is short, and only the notice gives way", () => {
    const rows = plain(
      fitHome(
        input({ banner: null, versions: { terminal: "0.0.120", app: "0.0.127" }, columns: 200 }),
        2,
      ),
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("터미널 앱 0.0.120");
  });

  it("never draws wider than the terminal at 40, 60, 80 and 120 columns", () => {
    for (const columns of [40, 60, 80, 120]) {
      for (const budget of [4, 8, 14, 40]) {
        for (const row of fitHome(
          input({ columns, versions: { terminal: "0.0.120", app: "0.0.127" } }),
          budget,
        )) {
          expect(visibleWidth(row), `@ ${columns}x${budget}: ${row}`).toBeLessThanOrEqual(
            columns - 1,
          );
        }
      }
    }
  });

  it("draws the wordmark in # and the arrows plain in the ascii preset, and no colour without a theme", () => {
    const ascii = plain(fitHome(input({ symbols: ASCII_SYMBOLS }), 40)).join("\n");
    expect(ascii).not.toMatch(/[█▄▀◆✓]/u);
    expect(ascii).toContain("#");
    expect(ascii).toContain("- 가 핵심");
    const noColor = fitHome(input({ theme: createTheme("oop", BUILTIN_THEMES.oop, 0) }), 40);
    for (const row of noColor) expect(row).toBe(stripAnsi(row));
  });

  it("answers for every built-in theme", () => {
    for (const [name, tokens] of Object.entries(BUILTIN_THEMES)) {
      const rows = fitHome(input({ theme: createTheme(name, tokens, 3) }), 40);
      expect(plain(rows).join("\n"), name).toContain("업데이트 있음");
    }
  });

  it("tells how tall it would be with all the room it could want", () => {
    expect(homeNaturalRows(input())).toBe(fitHome(input(), 1000).length);
    expect(homeNaturalRows(input({ banner: null, report: null }))).toBe(0);
  });
});

describe("composeHome", () => {
  const bottom = (count: number) => ({
    lines: Array.from({ length: count }, (_, index) => `행 ${index}`),
    cursor: { row: count - 2, col: 5 },
  });

  it("fills the frame to the given height with blank rows between the home and the foot", () => {
    const frame = composeHome(["머리 1", "머리 2"], bottom(3), 10);
    expect(frame.lines).toHaveLength(10);
    expect(frame.lines.slice(0, 2)).toEqual(["머리 1", "머리 2"]);
    expect(frame.lines.slice(2, 7).every((row) => row === "")).toBe(true);
    expect(frame.lines.slice(7)).toEqual(["행 0", "행 1", "행 2"]);
    expect(frame.cursor).toEqual({ row: 8, col: 5 });
  });

  it("leaves the cursor out when there is none", () => {
    expect(composeHome([], { lines: ["a"], cursor: null }, 3).cursor).toBeNull();
  });

  it("never cuts what is below: a panel as tall as the frame leaves no room for the home", () => {
    const panel = bottom(9);
    const frame = composeHome(["머리 1", "머리 2", "머리 3"], panel, 9);
    expect(frame.lines).toEqual(panel.lines);
    expect(frame.cursor).toEqual(panel.cursor);
    const taller = composeHome(["머리"], bottom(12), 9);
    expect(taller.lines).toHaveLength(12);
    expect(taller.lines[0]).toBe("행 0");
  });

  it("gives a panel above the composer its rows and trims the home to what remains", () => {
    const frame = composeHome(fitHome(input(), 12 - 8), bottom(8), 12);
    expect(frame.lines).toHaveLength(12);
    expect(frame.lines.slice(-8)).toEqual(bottom(8).lines);
    expect(plain(frame.lines.slice(0, 4)).join("\n")).toContain("업데이트 있음");
  });
});

describe("the start screen on a live region", () => {
  const rig = () => {
    const writes: string[] = [];
    const region = new LiveRegion(
      { write: (text) => void writes.push(text), columns: () => 100, rows: () => 24 },
      (run) => {
        pending.push(run);
        return () => undefined;
      },
    );
    const pending: Array<() => void> = [];
    return { region, writes, flush: () => region.flush() };
  };
  const frame = (report: UpdateReport | null) =>
    composeHome(
      fitHome(input({ report }), 18),
      { lines: ["│", "◆  메시지", "└"], cursor: { row: 1, col: 3 } },
      23,
    );

  it("writes nothing while nothing changes", () => {
    const { region, writes, flush } = rig();
    region.set(frame(null));
    flush();
    const first = writes.length;
    expect(first).toBe(1);
    region.set(frame(null));
    flush();
    expect(writes).toHaveLength(first);
  });

  it("rewrites only the rows the notice fills in when the answer arrives, without erasing the screen", () => {
    const { region, writes, flush } = rig();
    region.set(frame(null));
    flush();
    writes.length = 0;
    region.set(frame(UPDATE));
    flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("업데이트 있음");
    expect(writes[0]).not.toContain("\u001b[J");
    expect(writes[0]).not.toContain("메시지");
  });
});
