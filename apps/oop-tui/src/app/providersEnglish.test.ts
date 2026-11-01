import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { getLanguage, setLanguage, type Language } from "../i18n/index.ts";
import { makeStyle } from "../render/style.ts";
import { UNICODE_SYMBOLS } from "../render/symbols.ts";
import { stringWidth, stripAnsi } from "../text/width.ts";
import { renderAgentsPanel, EMPTY_AGENTS_VIEW, LOADING_AGENTS_VIEW } from "./agentsPanel.ts";
import { waitingText, type WaitingCrewThread } from "./crewBoard.ts";
import { PRESETS, parseCrewPreset, presetLabel, ROLE_HINT } from "./crew.ts";
import { collectFlags, resolveProviderRequest, parseProviderSlash } from "./providerArgs.ts";
import { planLines, type RemovePlan } from "./providerPlan.ts";
import { listTable } from "./providerCommand.ts";
import { validateEnvironmentName, validateInstanceId } from "./providerSpec.ts";
import { renderFlowPanel, parseFlowAction, STATE_WORDS, DOING_WORDS } from "./workflowPanel.ts";

let before: Language;
beforeEach(() => {
  before = getLanguage();
  setLanguage("en");
});
afterEach(() => setLanguage(before));

const cli = (...argv: string[]) => {
  const collected = collectFlags(argv);
  if (!collected.ok) return collected;
  return resolveProviderRequest(collected.value.positional, collected.value.flags, "cli");
};

const message = (result: { ok: boolean; message?: string }) =>
  result.ok ? "" : (result.message ?? "");

describe("provider arguments in English", () => {
  it("explains parse errors in English", () => {
    expect(message(cli("add", "nonsense"))).toMatch(/^Unknown kind: nonsense/);
    expect(message(cli("frobnicate"))).toContain("Unknown subcommand: frobnicate");
    expect(message(cli("add", "opencode", "--set"))).toContain("--set needs a value.");
    expect(message(parseProviderSlash("add codex -y"))).toContain("confirms on its own screen");
    expect(message(parseProviderSlash("add codex --secret A=B"))).toContain(
      "does not take secrets",
    );
    expect(message(cli("add"))).not.toMatch(/[가-힣]/u);
  });

  it("validates ids and environment names in English", () => {
    expect(validateInstanceId("", new Set())).toBe("An ID is required.");
    expect(validateInstanceId("a", new Set(["a"]))).toBe("'a' is already taken as an ID.");
    expect(validateEnvironmentName("1x")).toContain("malformed");
  });
});

describe("the provider list in English", () => {
  it("has English column titles that line up", () => {
    const lines = listTable([
      {
        id: "codex",
        name: "Codex",
        driver: "codex",
        enabled: true,
        status: "ready",
        tone: "ok",
        models: 3,
        message: null,
        isDefault: true,
      },
      {
        id: "x",
        name: "한글 이름",
        driver: "grok",
        enabled: false,
        status: "off",
        tone: "dim",
        models: null,
        message: null,
        isDefault: false,
      },
    ]);
    expect(lines[0]).toContain("Name");
    expect(lines[0]).toContain("Enabled");
    expect(lines[1]).toContain("default");
    const starts = lines.map((line) => stringWidth(line.slice(0, line.indexOf("  ", 12))));
    expect(starts.length).toBe(3);
    expect(lines.join("\n")).not.toMatch(/켜짐|꺼짐|기본/u);
  });
});

describe("crew words in English", () => {
  it("labels presets and roles in English and still parses the value", () => {
    expect(presetLabel("recommended")).toBe("OOP pick");
    expect(PRESETS.map((entry) => entry.label)).toEqual(["OOP pick", "Speed", "Quality", "Budget"]);
    expect(parseCrewPreset("Speed")).toBe("speed");
    expect(ROLE_HINT.auditor).toBe("review changed files");
  });

  it("says what a waiting crew task needs", () => {
    const approval = { kind: "approval" } as WaitingCrewThread;
    const input = { kind: "input" } as WaitingCrewThread;
    expect(waitingText([approval])).toBe("A crew task is waiting for approval — /crew");
    expect(waitingText([input])).toBe("A crew task is waiting for your answer — /crew");
    expect(waitingText([approval, input])).toBe(
      "2 crew tasks are waiting for approval or an answer — /crew",
    );
  });
});

describe("the side panels in English", () => {
  const base = {
    now: 0,
    online: true,
    columns: 60,
    rows: 30,
    style: makeStyle(false),
    symbols: UNICODE_SYMBOLS,
  };
  const agents = (view: Parameters<typeof renderAgentsPanel>[0]["view"], online = true) =>
    renderAgentsPanel({ ...base, view, online })
      .map(stripAnsi)
      .join("\n");

  it("draws the Agents panel texts", () => {
    expect(agents(null)).toContain("Open a thread and its agents show up here.");
    expect(agents(LOADING_AGENTS_VIEW)).toContain("Loading agents…");
    expect(agents(LOADING_AGENTS_VIEW, false)).toContain("Disconnected");
    expect(agents(EMPTY_AGENTS_VIEW)).toContain("Once this thread runs");
    expect(agents(EMPTY_AGENTS_VIEW)).not.toMatch(/[가-힣]/u);
  });

  it("draws the Workflow panel texts", () => {
    const draw = (flows: Parameters<typeof renderFlowPanel>[0]["flows"]) =>
      renderFlowPanel({ ...base, flows, pinnedId: null })
        .map(stripAnsi)
        .join("\n");
    expect(draw(null)).toContain("Open a thread and its workflow shows up here.");
    expect(draw([])).toContain("Steps appear here");
    expect(draw([])).toContain("/dag-workflow to close");
    expect(draw([])).not.toMatch(/[가-힣]/u);
  });

  it("has English state and activity words", () => {
    expect(STATE_WORDS.running).toBe("Working");
    expect(DOING_WORDS.read).toBe("Reading files…");
    expect(parseFlowAction(["next"])).toEqual({ kind: "next" });
  });
});

describe("the removal plan in English", () => {
  it("reads as plain sentences", () => {
    const plan = {
      id: "codex_work",
      name: "Work",
      driver: "codex",
      secrets: 2,
      threadsKnown: true,
      threads: { total: 3, running: 1, titles: ["A"] },
      crewPins: 1,
      textGeneration: true,
      projects: 2,
    } as unknown as RemovePlan;
    const text = planLines(plan).join("\n");
    expect(text).toContain("Remove: codex_work (Work,");
    expect(text).toContain("2 secrets stored on the server will be deleted too.");
    expect(text).toContain("(1 running) will stay as they are.");
    expect(text).toContain("  … and 2 more");
    expect(text).toContain("1 Crew roles pinned");
    expect(text).toContain("These selections do not change automatically");
    expect(text).not.toMatch(/[가-힣]/u);
  });
});
