import { describe, expect, it } from "vite-plus/test";

import type { AgentRow, PlanStep } from "../state/threadStatus.ts";
import { stripAnsi, visibleWidth } from "../text/width.ts";
import {
  DEFAULT_APPROVAL_OPTIONS,
  renderAgents,
  renderApprovalPanel,
  renderPlan,
  renderQuestionPanel,
  type ApprovalView,
  type QuestionView,
} from "./panels.ts";
import type { Rail } from "./rail.ts";
import { makeStyle } from "./style.ts";
import { ASCII_SYMBOLS, UNICODE_SYMBOLS } from "./symbols.ts";
import { BUILTIN_THEMES, createTheme } from "./theme.ts";

const theme = (level: 0 | 1 | 2 | 3 = 3) => createTheme("oop", BUILTIN_THEMES.oop, level);

const approval = (extra: Partial<ApprovalView> = {}): ApprovalView => ({
  requestKind: "command",
  detail: "pnpm install --frozen-lockfile",
  appName: undefined,
  options: DEFAULT_APPROVAL_OPTIONS,
  selected: null,
  locked: false,
  ...extra,
});

const question = (extra: Partial<QuestionView> = {}): QuestionView => ({
  index: 0,
  total: 1,
  header: "빌드 방식",
  question: "어떤 방식으로 빌드할까요?",
  options: [{ label: "전체", description: "모든 패키지" }, { label: "일부" }],
  multiSelect: false,
  allowCustom: true,
  dismissible: true,
  ...extra,
});

const WIDTHS = [5, 12, 15, 16, 17, 24, 40, 61, 80, 120, 200];

const railOf = (level: 0 | 1 | 2 | 3 = 0, symbols = UNICODE_SYMBOLS): Rail => ({
  style: makeStyle(theme(level)),
  symbols,
});

const approvalText = (extra: Partial<ApprovalView> = {}, columns = 80, rail = railOf()): string =>
  renderApprovalPanel(approval(extra), columns, rail).join("\n");

describe("approval and question panels", () => {
  it("never draw past the terminal edge, at any width, with Korean or wide text", () => {
    const long = "한국어로 된 아주 긴 명령 설명 ".repeat(8);
    for (const columns of WIDTHS) {
      for (const symbols of [UNICODE_SYMBOLS, ASCII_SYMBOLS]) {
        const rail = railOf(3, symbols);
        const lines = [
          ...renderApprovalPanel(
            approval({
              detail: long,
              appName: "앱",
              options: [{ decision: "accept", label: long, warning: long }],
            }),
            columns,
            rail,
          ),
          ...renderQuestionPanel(question({ question: long, header: long }), columns, rail),
        ];
        for (const line of lines) {
          // The panels never draw narrower than 10 columns, like the plan and the agent tree.
          expect(visibleWidth(line), `@ ${columns}: ${stripAnsi(line)}`).toBeLessThanOrEqual(
            Math.max(10, columns - 1),
          );
          expect(line).not.toMatch(/[\r\n]/u);
        }
      }
    }
  });

  it("hang off the rail: every row starts at the bar or the step mark, and nothing closes it", () => {
    const lines = renderApprovalPanel(approval(), 80, railOf()).map(stripAnsi);
    expect(lines[0]?.startsWith("◆  승인 필요: 명령 실행")).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith("│  ")).toBe(true);
    expect(lines.join("\n")).not.toMatch(/[└╭╰]/u);
    const asked = renderQuestionPanel(question(), 80, railOf()).map(stripAnsi);
    expect(asked[0]?.startsWith("◆  질문: 빌드 방식")).toBe(true);
    for (const line of asked.slice(1)) expect(line.startsWith("│  ")).toBe(true);
  });

  it("keep the content: kind, app, detail and every option numbered", () => {
    const text = approvalText({ appName: "Codex" });
    expect(text).toContain("승인 필요: 명령 실행 · Codex");
    expect(text).toContain("pnpm install --frozen-lockfile");
    for (const [index, option] of DEFAULT_APPROVAL_OPTIONS.entries()) {
      expect(text).toContain(`${index + 1} ${option.label}`);
    }
  });

  it("keep the title and every option on a terminal shorter than the command, cutting the command", () => {
    const detail = Array.from({ length: 30 }, (_, index) => `step-${index}`).join("\n");
    for (const maxRows of [30, 14, 12, 10, 9, 8]) {
      const lines = renderApprovalPanel(approval({ detail }), 80, railOf(), maxRows).map(stripAnsi);
      expect(lines.length, `@ ${maxRows} rows`).toBeLessThanOrEqual(maxRows);
      expect(lines[0]).toContain("승인 필요");
      for (const [index, option] of DEFAULT_APPROVAL_OPTIONS.entries()) {
        expect(lines.join("\n")).toContain(`${index + 1} ${option.label}`);
      }
      if (maxRows >= 10) expect(lines.at(-1)).toContain("Esc");
      expect(lines.join("\n")).toContain("step-0");
    }
    const cut = renderApprovalPanel(approval({ detail }), 80, railOf(), 10).map(stripAnsi);
    expect(cut.join("\n")).toContain("step-0");
    expect(cut.join("\n")).toMatch(/… \d+줄 더/u);
    expect(cut.join("\n")).not.toContain("step-29");
  });

  it("show the whole command, up to the usual limit, where there is room", () => {
    const detail = Array.from({ length: 4 }, (_, index) => `step-${index}`).join("\n");
    const lines = renderApprovalPanel(approval({ detail }), 80, railOf(), 40).map(stripAnsi);
    expect(lines.join("\n")).toContain("step-3");
    expect(lines.join("\n")).not.toContain("줄 더");
  });

  it("fill no option until a key has picked one, then fill exactly that one", () => {
    const marks = (selected: number | null) =>
      renderApprovalPanel(approval({ selected }), 80, railOf())
        .map(stripAnsi)
        .filter((line) => /[●○]/u.test(line))
        .map((line) => (line.includes("●") ? "●" : "○"));
    expect(marks(null)).toEqual(["○", "○", "○", "○"]);
    expect(marks(1)).toEqual(["○", "●", "○", "○"]);
  });

  it("say how to answer, and what Enter will do once an option is picked", () => {
    expect(approvalText()).toContain("↑/↓ 이동 • 번호 • Enter 확정 • Ctrl-T 나중에 • Esc 턴 중단");
    const picked = approvalText({ selected: 1 });
    expect(picked).toContain("Enter 로 '이 세션 동안 허용' 확정");
  });

  it("tell a locked panel how to unlock it, and keep Enter from looking armed", () => {
    const text = approvalText({ locked: true });
    expect(text).toContain("번호 잠김");
    expect(text).toContain("↑/↓ 를 누르면 풀립니다");
    expect(text).not.toContain("Enter 로");
  });

  it("show a dangerous option's warning on its own row under it", () => {
    const lines = renderApprovalPanel(
      approval({ options: [{ decision: "accept", label: "허용", warning: "되돌릴 수 없음" }] }),
      80,
      railOf(),
    ).map(stripAnsi);
    const at = lines.findIndex((line) => line.includes("1 허용"));
    expect(lines[at + 1]).toContain("되돌릴 수 없음");
  });

  it("take the shell off a command, keeping what it runs", () => {
    const text = approvalText({ detail: "/bin/zsh -lc 'git status --short'" });
    expect(text).toContain("git status --short");
    expect(text).not.toContain("/bin/zsh");
    expect(text).not.toContain("-lc");
  });

  it("cut a long detail to a few rows and count the rest", () => {
    const detail = Array.from({ length: 20 }, (_, index) => `줄 ${index}`).join("\n");
    const text = approvalText({ detail });
    expect(text).toContain("줄 5");
    expect(text).not.toContain("줄 6");
    expect(text).toContain("… 14줄 더");
  });

  it("colour the rail by kind: warning for approvals, accent for questions", () => {
    const rail = railOf(3);
    const { theme: t } = rail.style;
    expect(renderApprovalPanel(approval(), 80, rail)[1]).toContain(t.warning("│"));
    expect(renderApprovalPanel(approval(), 80, rail)[1]).not.toContain(t.accent("│"));
    expect(renderQuestionPanel(question(), 80, rail)[1]).toContain(t.accent("│"));
  });

  it("number the questions, show the options with their notes, and say how to answer", () => {
    const text = renderQuestionPanel(question({ index: 1, total: 3 }), 120, railOf())
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("질문 (2/3): 빌드 방식");
    expect(text).toContain("어떤 방식으로 빌드할까요?");
    expect(text).toMatch(/1 {2}전체 - 모든 패키지/u);
    expect(text).toMatch(/2 {2}일부/u);
    expect(text).toContain("번호 입력 • 또는 직접 답변 • Esc 건너뛰기 • Ctrl-T 나중에");
  });

  it("fold the question hint at a separator, never in the middle of a key", () => {
    const rows = renderQuestionPanel(question(), 40, railOf()).map(stripAnsi);
    const hint = rows.filter((row) => /번호|직접|Esc|Ctrl-T|건너뛰기|나중에/u.test(row));
    expect(hint.length).toBeGreaterThan(1);
    for (const row of hint) expect(row.slice(3).startsWith("•")).toBe(false);
    expect(hint.join(" ")).toContain("Ctrl-T 나중에");
  });

  it("ask for a comma separated list on a multi select question", () => {
    const text = renderQuestionPanel(question({ multiSelect: true }), 120, railOf())
      .map(stripAnsi)
      .join("\n");
    expect(text).toContain("번호를 쉼표로 구분해 입력");
  });

  it("use only ASCII under the ascii preset and no colour codes without colour", () => {
    const rail = railOf(0, ASCII_SYMBOLS);
    const lines = [
      ...renderApprovalPanel(approval({ selected: 0 }), 80, rail),
      ...renderQuestionPanel(question(), 80, rail),
    ];
    for (const line of lines) {
      expect(line).toBe(stripAnsi(line));
      expect(line).not.toMatch(/[╭╮╰╯─│◆◇●○▲]/u);
    }
    expect(lines.join("\n")).toContain("(*)");
  });

  it("strip control sequences out of the request text", () => {
    const text = approvalText({
      detail: "rm\u001b[2J -rf\u001b]52;c;QQ==\u0007",
      appName: "a\u001b[31mb",
    });
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
  });
});

const steps = (...statuses: PlanStep["status"][]): PlanStep[] =>
  statuses.map((status, index) => ({ step: `단계 ${index + 1}`, status }));

describe("a question taller than its room", () => {
  const long = Array.from({ length: 12 }, (_, index) => `줄 ${index}`).join("\n");

  it("cuts the question from its end, never the header, the options or how to answer", () => {
    for (const maxRows of [20, 12, 9, 8, 7, 6]) {
      const lines = renderQuestionPanel(question({ question: long }), 80, railOf(), maxRows).map(
        stripAnsi,
      );
      const text = lines.join("\n");
      expect(lines.length, `@ ${maxRows}`).toBeLessThanOrEqual(maxRows);
      expect(text).toContain("질문: 빌드 방식");
      expect(text).toContain("1  전체");
      expect(text).toContain("2  일부");
      expect(text).toContain("Ctrl-T 나중에");
    }
    const cut = renderQuestionPanel(question({ question: long }), 80, railOf(), 8).map(stripAnsi);
    expect(cut.join("\n")).toMatch(/… \d+줄 더/u);
    expect(cut.join("\n")).toContain("줄 0");
  });

  it("is whole when the room is enough, and when no room is given", () => {
    const whole = renderQuestionPanel(question({ question: long }), 80, railOf());
    expect(whole.map(stripAnsi).join("\n")).toContain("줄 11");
    expect(renderQuestionPanel(question({ question: long }), 80, railOf(), 99)).toEqual(whole);
  });
});

describe("renderPlan", () => {
  const options = (extra: Partial<Parameters<typeof renderPlan>[1]> = {}) => ({
    collapsed: false,
    foldable: true,
    columns: 80,
    maxRows: 8,
    theme: theme(0),
    symbols: UNICODE_SYMBOLS,
    ...extra,
  });

  it("shows progress, a bar and one row per step with its mark", () => {
    const lines = renderPlan(
      steps("completed", "completed", "inProgress", "pending", "pending"),
      options(),
    );
    expect(lines[0]).toBe("계획 2/5 ━━━━──────  Ctrl-T 접기");
    expect(lines.slice(1)).toEqual([
      "  ☑ 단계 1",
      "  ☑ 단계 2",
      "  ◐ 단계 3",
      "  ☐ 단계 4",
      "  ☐ 단계 5",
    ]);
  });

  it("offers no Ctrl-T while a panel waits for an answer", () => {
    for (const collapsed of [false, true]) {
      const lines = renderPlan(
        steps("completed", "pending"),
        options({ collapsed, foldable: false }),
      );
      expect(lines[0]).toBe("계획 1/2 ━━━━━─────");
    }
  });

  it("is only the header when folded, and offers to unfold", () => {
    const lines = renderPlan(steps("completed", "pending"), options({ collapsed: true }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Ctrl-T 펼치기");
  });

  it("never exceeds maxRows and keeps the active step in view", () => {
    const many = steps(
      ...Array.from({ length: 12 }, (_, i): PlanStep["status"] =>
        i < 8 ? "completed" : i === 8 ? "inProgress" : "pending",
      ),
    );
    for (const maxRows of [1, 2, 3, 6, 10]) {
      const lines = renderPlan(many, options({ maxRows }));
      expect(lines.length).toBeLessThanOrEqual(maxRows);
    }
    expect(renderPlan(many, options({ maxRows: 4 })).join("\n")).toContain("◐ 단계 9");
  });

  it("is nothing for no plan or no room", () => {
    expect(renderPlan([], options())).toEqual([]);
    expect(renderPlan(steps("pending"), options({ maxRows: 0 }))).toEqual([]);
  });

  it("fits narrow terminals and Korean step names, in ascii too", () => {
    const korean: PlanStep[] = [
      { step: "아주 긴 한국어 단계 설명을 적습니다 ".repeat(4), status: "inProgress" },
    ];
    for (const columns of [5, 20, 40, 80]) {
      for (const symbols of [UNICODE_SYMBOLS, ASCII_SYMBOLS]) {
        for (const line of renderPlan(korean, options({ columns, symbols }))) {
          expect(visibleWidth(line), `@ ${columns}`).toBeLessThanOrEqual(Math.max(10, columns - 1));
        }
      }
    }
    expect(
      renderPlan(steps("completed", "pending"), options({ symbols: ASCII_SYMBOLS })).join("\n"),
    ).toContain("[x] 단계 1");
  });
});

describe("renderAgents", () => {
  const agents = (count: number): AgentRow[] =>
    Array.from({ length: count }, (_, index) => ({
      id: `a${index}`,
      name: `agent-${index}`,
      work: index === 0 ? "테스트 실행" : null,
      startedAt: 1_000,
    }));
  const options = (extra: Partial<Parameters<typeof renderAgents>[1]> = {}) => ({
    now: 13_000,
    columns: 80,
    maxRows: 4,
    theme: theme(0),
    symbols: UNICODE_SYMBOLS,
    ...extra,
  });

  it("draws a tree, the last branch closing it, with work and elapsed time", () => {
    expect(renderAgents(agents(2), options())).toEqual([
      "├─ agent-0 · 테스트 실행 · 12s",
      "└─ agent-1 · 12s",
    ]);
  });

  it("counts the agents it has no row for, within maxRows", () => {
    const lines = renderAgents(agents(6), options({ maxRows: 4 }));
    expect(lines).toHaveLength(4);
    expect(lines.at(-1)).toBe("└─ … 외 3개");
  });

  it("leaves out the time of an agent with no start, and never shows a negative one", () => {
    const rows: AgentRow[] = [
      { id: "a", name: "x", work: null, startedAt: null },
      { id: "b", name: "y", work: null, startedAt: 99_000 },
    ];
    expect(renderAgents(rows, options())).toEqual(["├─ x", "└─ y · 0s"]);
  });

  it("gives each agent its own colour from the theme", () => {
    const t = theme(3);
    const lines = renderAgents(agents(2), options({ theme: t }));
    expect(lines[0]).toContain(t.agent(0)("├─"));
    expect(lines[1]).toContain(t.agent(1)("└─"));
  });

  it("fits narrow terminals and is nothing for no agents", () => {
    for (const columns of [5, 20, 40]) {
      for (const line of renderAgents(agents(3), options({ columns }))) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(10, columns - 1));
      }
    }
    expect(renderAgents([], options())).toEqual([]);
  });
});
