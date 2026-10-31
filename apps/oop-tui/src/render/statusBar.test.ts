import { describe, expect, it } from "vite-plus/test";

import { stripAnsi, visibleWidth } from "../text/width.ts";
import { renderStatusBar, type StatusBarInput } from "./statusBar.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const theme = (level: 0 | 1 | 2 | 3 = 3) => createTheme("oop", BUILTIN_THEMES.oop, level);

const FULL: StatusBarInput = {
  model: "gpt-5",
  effort: "high",
  mode: "full-access",
  cwd: "/home/me/work/app",
  home: "/home/me",
  branch: "main",
  contextPercent: 42,
  costUsd: 0.12,
  costPartial: false,
  agents: 2,
  hint: "/help 도움말",
};

const bar = (
  input: Partial<StatusBarInput>,
  width: number,
  options: {
    level?: 0 | 1 | 2 | 3;
    symbols?: typeof UNICODE_SYMBOLS;
    setting?: "auto" | "full" | "compact" | "minimal";
  } = {},
) =>
  renderStatusBar(
    { ...FULL, ...input },
    width,
    theme(options.level ?? 3),
    options.symbols ?? UNICODE_SYMBOLS,
    options.setting ?? "auto",
  );

describe("renderStatusBar", () => {
  it("shows every segment, in order, when there is room", () => {
    const text = stripAnsi(bar({}, 120));
    expect(text).toBe(
      "gpt-5 high │ full-access │ ~/work/app ⎇ main │ ▰▰▱▱▱ 42% │ $0.12 │ 에이전트 2 │ /help 도움말",
    );
  });

  it("never draws wider than the terminal, at any width, in any setting", () => {
    for (const setting of ["auto", "full", "compact", "minimal"] as const) {
      for (let width = 8; width <= 130; width += 1) {
        const line = bar({}, width, { setting });
        expect(visibleWidth(line), `${setting} @ ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps model and path at 80 columns and gives up the hint first", () => {
    const text = stripAnsi(bar({ cwd: "/home/me/work/some/deep/project/app" }, 80));
    expect(text).toContain("gpt-5");
    expect(text).toContain("app");
    expect(text).not.toContain("/help");
  });

  it("at 40 columns still names the model and the context share", () => {
    const text = stripAnsi(bar({}, 40));
    expect(visibleWidth(text)).toBeLessThanOrEqual(40);
    expect(text).toContain("gpt-5");
    expect(text).toContain("42%");
  });

  it("leaves a segment out entirely when it has no value", () => {
    const text = stripAnsi(
      bar(
        {
          effort: null,
          mode: null,
          branch: null,
          contextPercent: null,
          costUsd: null,
          agents: 0,
          hint: null,
        },
        120,
      ),
    );
    expect(text).toBe("gpt-5 │ ~/work/app");
    expect(text).not.toMatch(/│\s*│/u);
    expect(text).not.toMatch(/\$|%|에이전트|⎇/u);
  });

  it("is empty when nothing is known, and does not name the app (the rail row does)", () => {
    const text = stripAnsi(
      bar(
        {
          model: null,
          effort: null,
          mode: null,
          cwd: null,
          branch: null,
          contextPercent: null,
          costUsd: null,
          agents: 0,
          hint: null,
        },
        80,
      ),
    );
    expect(text).toBe("");
  });

  it("shortens a long path from the front and keeps the branch", () => {
    const text = stripAnsi(
      bar({ cwd: "/home/me/a/very/long/path/to/some/project/folder", hint: null, agents: 0 }, 62, {
        setting: "full",
      }),
    );
    expect(text).toContain("…");
    expect(text).toContain("folder");
    expect(text).toContain("main");
    expect(visibleWidth(text)).toBeLessThanOrEqual(62);
  });

  it("counts Korean text by its screen width", () => {
    const input = { model: "모델-가나다", cwd: "/home/me/작업/프로젝트", agents: 0, hint: null };
    for (let width = 30; width <= 90; width += 5) {
      expect(visibleWidth(bar(input, width)), `@ ${width}`).toBeLessThanOrEqual(width);
    }
    const text = stripAnsi(bar(input, 90));
    expect(text).toContain("모델-가나다");
    expect(text).toContain("~/작업/프로젝트");
  });

  it("honours the chosen level", () => {
    const compact = stripAnsi(bar({}, 120, { setting: "compact" }));
    expect(compact).not.toContain("▰");
    expect(compact).not.toContain("high");
    expect(compact).toContain("42%");
    expect(compact).not.toContain("/help");
    const minimal = stripAnsi(bar({}, 120, { setting: "minimal" }));
    expect(minimal).toBe("gpt-5 │ 42%");
    const full = stripAnsi(bar({}, 120, { setting: "full" }));
    expect(full).toContain("▰▰▱▱▱ 42%");
  });

  it("steps the context colour at 50, 70 and 90 percent", () => {
    const colour = (percent: number) =>
      bar({ contextPercent: percent }, 120).match(
        new RegExp(`(${String.fromCharCode(27)}\\[[0-9;]*m)[▰▱]+`, "u"),
      )?.[1];
    const seen = [49, 50, 69, 70, 89, 90].map(colour);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[1]).toBe(seen[2]);
    expect(seen[2]).not.toBe(seen[3]);
    expect(seen[3]).toBe(seen[4]);
    expect(seen[4]).not.toBe(seen[5]);
    expect(new Set(seen).size).toBe(4);
  });

  it("marks a cost that covers only part of the thread, and a very small one", () => {
    expect(stripAnsi(bar({ costUsd: 0.12, costPartial: true }, 120))).toContain("$0.12+");
    expect(stripAnsi(bar({ costUsd: 0.004 }, 120))).toContain("<$0.01");
    expect(stripAnsi(bar({ costUsd: 0 }, 120))).toContain("$0.00");
  });

  it("uses only ASCII under the ascii preset", () => {
    const text = bar({ hint: "/help" }, 120, { symbols: ASCII_SYMBOLS });
    expect(stripAnsi(text)).toBe(
      "gpt-5 high | full-access | ~/work/app @ main | ##--- 42% | $0.12 | 에이전트 2 | /help",
    );
    expect(stripAnsi(text)).not.toMatch(/[◆│⎇▰▱]/u);
    expect(stripAnsi(bar({}, 120))).not.toContain("OOP");
  });

  it("is plain text with no colour", () => {
    const text = bar({}, 120, { level: 0 });
    expect(text).toBe(stripAnsi(text));
    expect(text).not.toContain("\u001b");
  });

  it("strips control sequences out of server-supplied text", () => {
    const text = bar(
      { model: "m\u001b[2Jx", branch: "b\u001b]52;c;QQ==\u0007r", cwd: "/home/me/p\u001b[31m" },
      120,
    );
    expect(text).not.toContain("\u001b[2J");
    expect(text).not.toContain("\u001b]52");
    expect(text).not.toContain("\u0007");
  });
});

describe("renderStatusBar plan and goal", () => {
  it("shows plan mode and the goal after the permission mode", () => {
    const text = stripAnsi(bar({ plan: "계획 모드", goal: "목표 2/5" }, 160));
    expect(text).toContain("full-access │ 계획 모드 │ 목표 2/5 │ ~/work/app");
  });

  it("says a held mode as it is given", () => {
    expect(stripAnsi(bar({ plan: "기본 모드 (다음 턴)" }, 160))).toContain("기본 모드 (다음 턴)");
  });

  it("leaves both out when there is nothing to say, and in the minimal line", () => {
    const quiet = stripAnsi(bar({ plan: null, goal: null }, 160));
    expect(quiet).not.toContain("계획");
    expect(quiet).not.toContain("목표");
    expect(
      stripAnsi(bar({ plan: "계획 모드", goal: "목표 2/5" }, 160, { setting: "minimal" })),
    ).not.toContain("목표");
  });

  it("never draws wider than the terminal with them", () => {
    for (const width of [30, 40, 61, 80]) {
      const text = bar({ plan: "계획 모드 (다음 턴)", goal: "목표 12+/20" }, width);
      expect(visibleWidth(text), `@ ${width}`).toBeLessThanOrEqual(width);
    }
  });
});

describe("the crew segment", () => {
  it("shows the crew after the goal, and leaves it out when there is none", () => {
    expect(stripAnsi(bar({ crew: "crew 1/3" }, 160))).toContain("crew 1/3 │ ");
    expect(stripAnsi(bar({ crew: null }, 160))).not.toContain("crew");
  });

  it("is dropped from the minimal bar unless a request waits for the user", () => {
    expect(stripAnsi(bar({ crew: "crew" }, 160, { setting: "minimal" }))).not.toContain("crew");
    expect(
      stripAnsi(
        bar({ crew: "crew 승인·질문 대기 1", crewAlert: true }, 160, { setting: "minimal" }),
      ),
    ).toContain("crew 승인·질문 대기 1");
  });

  it("colours a waiting request as a warning", () => {
    const plain = bar({ crew: "crew 대기", crewAlert: false }, 160);
    const alert = bar({ crew: "crew 대기", crewAlert: true }, 160);
    expect(alert).not.toBe(plain);
    expect(stripAnsi(alert)).toBe(stripAnsi(plain));
  });

  it("never draws wider than the terminal with it", () => {
    for (const width of [30, 40, 61, 80]) {
      const text = bar({ crew: "crew 승인·질문 대기 2", crewAlert: true }, width);
      expect(visibleWidth(text), `@ ${width}`).toBeLessThanOrEqual(width);
    }
  });
});
