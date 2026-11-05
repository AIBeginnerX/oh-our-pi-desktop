import { describe, expect, it } from "vite-plus/test";

import {
  AUDIT_DIFF_MAX_CHARS,
  CREW_MAX_FIX_ROUNDS,
  CREW_REPORT_MAX_FINDINGS,
  auditDiff,
  auditPrompt,
  auditVerdict,
  clipCrewReport,
  crewFailureKind,
  crewLimitWindowName,
  crewReportStatus,
  followUpRound,
  isCrewFollowUp,
  planFollowUp,
  claudeSubagentModel,
  crewBrief,
  crewExhaustedReport,
  crewMemberOutcome,
  crewTaskStatus,
  crewThreadTitle,
  withTodoOutcome,
  delegatePrompt,
  withCrewMemoryReferences,
  withoutCrewMemoryReferences,
  isCrewThreadTitle,
  overlappingWriteScopes,
  parseAuditReport,
  parseCrewReport,
  reportExcerpt,
  isTestCommand,
  latestAuditAsksChanges,
  planTurnAudit,
  turnChangedLines,
  turnRanPassingTests,
  writeScopeWarning,
} from "./crewLogic.ts";
import { assignTodos } from "./crewTodos.ts";

const turn = (state: "running" | "completed" | "interrupted" | "error") =>
  ({
    latestTurn: {
      turnId: "turn-1",
      state,
      requestedAt: "2026-10-14T00:00:00.000Z",
      startedAt: null,
      completedAt: null,
      assistantMessageId: null,
    },
  }) as never;

describe("crew threads", () => {
  it("names a crew thread by role and marks it as crew work", () => {
    const title = crewThreadTitle("worker", "Add   tests\nfor the parser");
    expect(title).toBe("Crew Worker · Add tests for the parser");
    expect(isCrewThreadTitle(title)).toBe(true);
    expect(isCrewThreadTitle("Crew planning notes")).toBe(false);
  });

  it("shortens long subjects so the sidebar stays readable", () => {
    expect(crewThreadTitle("expert", "x".repeat(100)).length).toBeLessThanOrEqual(
      "Crew Expert · ".length + 60,
    );
  });

  it("reads a crew thread's progress from its latest turn", () => {
    expect(crewTaskStatus({ latestTurn: null, session: null } as never)).toBe("starting");
    expect(crewTaskStatus(turn("running"))).toBe("running");
    expect(crewTaskStatus(turn("completed"))).toBe("completed");
    expect(crewTaskStatus(turn("error"))).toBe("failed");
  });
});

describe("audits", () => {
  const base = {
    changedFiles: 2,
    changedLines: 120,
    testsPassed: false,
    changesRequested: false,
    auditorPinned: false,
    threadTitle: "Fix login",
    crewEnabled: true,
    hasAuditor: true,
  };
  const command = (turnId: string | null, text: string, status = "completed") => ({
    kind: "tool.completed",
    turnId,
    payload: { itemType: "command_execution", status, data: { item: { command: text } } },
  });

  it("audits a lead turn that changed many lines, even with tests passing", () => {
    expect(planTurnAudit(base)).toBe("full");
    expect(planTurnAudit({ ...base, testsPassed: true })).toBe("full");
  });

  it("leaves out turns without changes, crew threads, and threads with the crew off", () => {
    expect(planTurnAudit({ ...base, changedFiles: 0 })).toBe("none");
    expect(planTurnAudit({ ...base, threadTitle: "Crew Worker · Add tests" })).toBe("none");
    expect(planTurnAudit({ ...base, crewEnabled: false })).toBe("none");
    expect(planTurnAudit({ ...base, hasAuditor: false })).toBe("none");
  });

  it("skips a small change the turn's own tests passed, and hands the rest to a fast model", () => {
    expect(planTurnAudit({ ...base, changedLines: 8, testsPassed: true })).toBe("skipped");
    expect(planTurnAudit({ ...base, changedLines: 8 })).toBe("fast");
    expect(planTurnAudit({ ...base, changedLines: 20, testsPassed: true })).toBe("skipped");
    expect(planTurnAudit({ ...base, changedLines: 21, testsPassed: true })).toBe("full");
  });

  it("fully reviews a fix after an audit asked for changes, and keeps a pinned auditor", () => {
    const small = { ...base, changedLines: 8 };
    expect(planTurnAudit({ ...small, testsPassed: true, changesRequested: true })).toBe("full");
    expect(planTurnAudit({ ...small, changesRequested: true })).toBe("full");
    expect(planTurnAudit({ ...small, auditorPinned: true })).toBe("full");
    expect(planTurnAudit({ ...small, auditorPinned: true, testsPassed: true })).toBe("skipped");
  });

  it("never counts a turn with a zero-line file, such as a binary or a rename, as small", () => {
    expect(turnChangedLines([{ additions: 3, deletions: 2 }])).toBe(5);
    expect(
      turnChangedLines([
        { additions: 3, deletions: 2 },
        { additions: 0, deletions: 0 },
      ]),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("reads the thread's latest audit verdict", () => {
    const audit = (verdict: string, createdAt: string, crewRole = "auditor") => ({
      kind: "task.completed",
      createdAt,
      payload: { crewRole, taskId: createdAt, verdict },
    });
    expect(latestAuditAsksChanges([])).toBe(false);
    expect(latestAuditAsksChanges([audit("needs-changes", "2026-10-18T00:01:00Z")])).toBe(true);
    expect(
      latestAuditAsksChanges([
        audit("approve", "2026-10-18T00:02:00Z"),
        audit("needs-changes", "2026-10-18T00:01:00Z"),
      ]),
    ).toBe(false);
    expect(
      latestAuditAsksChanges([
        audit("needs-changes", "2026-10-18T00:01:00Z"),
        audit("approve", "2026-10-18T00:02:00Z", "worker"),
      ]),
    ).toBe(true);
  });

  it("counts only commands whose own exit status is a test runner's", () => {
    for (const command of [
      "vp test run src/a.test.ts",
      "cd apps/server && pnpm exec vitest run",
      "CI=1 npx jest",
      "python -m pytest -q",
      "/bin/zsh -lc 'cargo test'",
      "pnpm build && npm test",
    ]) {
      expect(isTestCommand(command), command).toBe(true);
    }
    for (const command of [
      "cat vitest.config.ts",
      "ls jest/",
      "grep pytest README.md",
      'echo "cargo test later"',
      "npm test || true",
      "vitest run | tail -5",
      "npm test; echo done",
    ]) {
      expect(isTestCommand(command), command).toBe(false);
    }
  });

  it("reads the command from each provider's shape, not its output", () => {
    const done = (data: unknown, extra: Record<string, unknown> = {}) => ({
      kind: "tool.completed",
      turnId: "turn-1",
      payload: { itemType: "command_execution", status: "completed", data, ...extra },
    });
    const claude = done({ toolName: "Bash", input: { command: "npm test" }, result: "ok" });
    const opencode = done({ command: "bun test" }, { detail: "12 pass" });
    const catOutput = done({ command: "cat package.json" }, { detail: '"test": "vitest run"' });
    expect(turnRanPassingTests("turn-1", [claude])).toBe(true);
    expect(turnRanPassingTests("turn-1", [opencode])).toBe(true);
    expect(turnRanPassingTests("turn-1", [catOutput])).toBe(false);
    const edit = {
      kind: "tool.completed",
      turnId: "turn-1",
      payload: { itemType: "file_change", status: "completed" },
    };
    expect(turnRanPassingTests("turn-1", [claude, edit])).toBe(false);
    expect(turnRanPassingTests("turn-1", [edit, claude])).toBe(true);
  });

  it("reads a passing test run from the turn's own finished commands", () => {
    expect(turnRanPassingTests("turn-1", [command("turn-1", "vp test run src/a.test.ts")])).toBe(
      true,
    );
    expect(turnRanPassingTests("turn-1", [command("turn-1", "pytest -q tests")])).toBe(true);
    expect(turnRanPassingTests("turn-1", [command("turn-2", "npm test")])).toBe(false);
    expect(turnRanPassingTests("turn-1", [command("turn-1", "npm test", "failed")])).toBe(false);
    expect(turnRanPassingTests("turn-1", [command("turn-1", "git status")])).toBe(false);
    expect(turnRanPassingTests("turn-1", [command("turn-1", "rg latest-results")])).toBe(false);
  });

  it("lists at most forty changed files in the audit prompt", () => {
    const files = Array.from({ length: 45 }, (_, index) => `src/file-${index}.ts`);
    const prompt = auditPrompt({ leadTitle: "Fix login", files, request: null });
    expect(prompt).toContain("- src/file-39.ts");
    expect(prompt).not.toContain("- src/file-40.ts");
    expect(prompt).toContain("- and 5 more");
    expect(prompt).toContain("Do not edit anything.");
  });
});

describe("delegation", () => {
  it("tells the crew member its role, the lead thread, and the task", () => {
    const prompt = delegatePrompt({
      role: "expert",
      leadTitle: "Fix login",
      task: "  Trace the token bug  ",
    });
    expect(prompt).toContain("You are the expert on an OOP crew");
    expect(prompt).toContain('"Fix login"');
    expect(prompt.endsWith("Trace the token bug")).toBe(true);
  });

  it("keeps report excerpts short for activity summaries", () => {
    expect(reportExcerpt("a".repeat(400)).length).toBe(280);
  });
});

describe("crew brief", () => {
  const option = (label: string, providerLabel: string) => ({ label, providerLabel });

  it("names each staffed role and the exact crew tool for the brain", () => {
    const brief = crewBrief({
      worker: option("GLM-5.3 Flash", "OpenCode"),
      expert: option("GPT-6.1 Sol", "Codex"),
      auditor: null,
    });
    expect(brief).toContain("- worker: GLM-5.3 Flash (OpenCode)");
    expect(brief).toContain("- expert: GPT-6.1 Sol (Codex)");
    expect(brief).not.toContain("- auditor:");
    expect(brief).toContain("mcp__t3-code__crew_delegate");
  });

  it("tells the brain that a later note replaces the earlier crew, fast-path model included", () => {
    // The lead's conversation keeps the first note after the user changes a crew member, so each
    // note must say it is the one to follow or the lead keeps handing work to the old model.
    const brief = crewBrief({
      worker: { label: "Haiku", providerLabel: "Claude", native: "haiku" },
      expert: null,
      auditor: null,
    })!;
    expect(brief).toContain("replaces any earlier <oop_crew> note");
    expect(brief).toContain("the model you pass to the Agent tool");
    expect(brief).toContain("Fast-path agents get no OOP fallback or cooling");
    // A change made while the turn runs reaches the brain through crew_roster.
    expect(brief).toContain("call crew_roster");
  });

  it("tells the brain to give each task concrete todos with checks", () => {
    // Without this rule the lead hands out tasks with no checklist, so nothing tells the member
    // what "finished" means and the server has nothing to verify.
    const brief = crewBrief({
      worker: option("GLM-5.3 Flash", "OpenCode"),
      expert: null,
      auditor: null,
    })!;
    expect(brief).toContain("specific one-step todos");
    expect(brief).toContain("a check (command or files)");
    expect(brief).toContain("extra work in a new task");
    expect(brief).toContain("unfinished items make it partial");
  });

  it("tells the brain to call work done only on a VERIFIED proof", () => {
    const brief = crewBrief({ worker: option("GLM", "OpenCode"), expert: null, auditor: null })!;
    expect(brief).toContain("Call work done only when crew_wait shows proof VERIFIED.");
    expect(brief).toContain('say "finished, not verified" to the user');
  });

  it("asks for a why on delegating and stopping inside the Each task line", () => {
    const brief = crewBrief({ worker: option("GLM", "OpenCode"), expert: null, auditor: null })!;
    const line = brief.split("\n").find((entry) => entry.startsWith("Each task:"))!;
    expect(line).toContain('"why"');
    expect(line).toContain("crew_delegate and crew_stop");
  });

  it("explains the arena in a few lines the brain can follow", () => {
    const brief = crewBrief({ worker: option("GLM", "OpenCode"), expert: null, auditor: null })!;
    expect(brief).toContain("Arena (only when the user asks to compare approaches");
    expect(brief).toContain('isolation "candidate"');
    expect(brief).toContain("differentFrom");
    expect(brief).toContain("judge was not independent");
    expect(brief).toContain("remove the worktrees");
    expect(brief).toContain("Candidate A");
  });

  it("sends nothing when no role is staffed", () => {
    expect(crewBrief({ worker: null, expert: null, auditor: null })).toBeNull();
  });

  it("tells a lead with only an auditor the truth: do the work itself, the auditor reviews on its own", () => {
    const brief = crewBrief({ worker: null, expert: null, auditor: option("Opus", "Claude") })!;
    expect(brief).toContain("only the auditor is set");
    expect(brief).toContain("do the work yourself");
    expect(brief).toContain("auditor (Opus, Claude)");
    expect(brief).not.toContain("Rules for this turn");
    expect(brief).not.toContain("now off");
  });
});

describe("crew fallback", () => {
  it("treats a provider that died before its first turn as failed", () => {
    const session = (status: string, lastError: string | null) =>
      ({ latestTurn: null, session: { status, lastError } }) as never;
    expect(crewTaskStatus(session("stopped", "Insufficient balance"))).toBe("failed");
    expect(crewTaskStatus(session("starting", null))).toBe("starting");
    expect(crewTaskStatus(session("starting", "retrying"))).toBe("starting");
  });

  it("tells the brain to take a task over and why every model failed", () => {
    const report = crewExhaustedReport("worker", [
      { model: "GLM-5.3 Flash (OpenCode)", error: "Insufficient balance" },
      { model: "Haiku (Claude)" },
    ]);
    expect(report).toContain("do this task yourself");
    expect(report).toContain("- GLM-5.3 Flash (OpenCode): Insufficient balance");
    expect(report).toContain("- Haiku (Claude): failed");
  });
});

describe("crew fast path", () => {
  it("maps Claude model slugs to the Agent tool's model values", () => {
    expect(
      ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5-5", "gpt-6.1-sol"].map(
        claudeSubagentModel,
      ),
    ).toEqual(["haiku", "sonnet", "opus", null]);
  });

  it("routes same-provider roles to the Agent tool and others to crew_delegate", () => {
    const brief = crewBrief({
      worker: { label: "Haiku", providerLabel: "Claude", native: "haiku" },
      expert: { label: "GPT-6.1 Sol", providerLabel: "Codex" },
      auditor: null,
    })!;
    expect(brief).toContain(
      '- worker: Haiku (Claude) [fast path: your Agent tool with model "haiku"]',
    );
    expect(brief).toContain("- expert: GPT-6.1 Sol (Codex) [crew_delegate]");
    expect(brief).toContain("2. Fast path (worker)");
    expect(brief).toContain("3. Other roles (expert)");
  });

  it("leaves out the crew_delegate rule when every role takes the fast path", () => {
    const brief = crewBrief({
      worker: { label: "Haiku", providerLabel: "Claude", native: "haiku" },
      expert: { label: "Opus", providerLabel: "Claude", native: "opus" },
      auditor: null,
    })!;
    expect(brief).not.toContain("Other roles");
  });
});

describe("crew follow-ups", () => {
  it("reads the auditor's last verdict line in any common spelling", () => {
    expect(auditVerdict("Looks fine.\nVerdict: approve")).toBe("approve");
    expect(auditVerdict("- missing test\n**Verdict:** needs changes")).toBe("needs-changes");
    expect(auditVerdict("Verdict: needs changes\n...after a second look\nVerdict: `approve`")).toBe(
      "approve",
    );
    expect(auditVerdict("no verdict here")).toBeNull();
    expect(auditVerdict(null)).toBeNull();
  });

  it("sends an audit fix and late reports with a round marker it can read back", () => {
    const plan = planFollowUp({
      current: { round: 0, fixes: 0 },
      audits: ["- blocking: off by one"],
      results: [{ role: "expert", subject: "port parser", status: "completed", report: "done" }],
    });
    expect(plan.dropped).toBe(false);
    expect(plan.prompt).toContain("off by one");
    expect(plan.prompt).toContain("Expert · port parser (completed): done");
    expect(followUpRound(plan.prompt)).toEqual({ round: 1, fixes: 1 });
    expect(followUpRound("a real user message")).toEqual({ round: 0, fixes: 0 });
  });

  it("shows each late report's proof so the lead can tell finished from verified", () => {
    const plan = planFollowUp({
      current: { round: 0, fixes: 0 },
      audits: [],
      results: [
        {
          role: "worker",
          subject: "tests",
          status: "completed",
          report: "done",
          proof: "INCONCLUSIVE",
        },
      ],
    });
    expect(plan.prompt).toContain("Worker · tests (completed, proof INCONCLUSIVE): done");
  });

  it("hands results on as plain information once the crew is off, with no audit fix", () => {
    const plan = planFollowUp({
      current: { round: 0, fixes: 0 },
      audits: ["- blocking: off by one"],
      results: [{ role: "expert", subject: "port parser", status: "completed", report: "done" }],
      crewOff: true,
    });
    expect(plan.prompt).toContain("Expert · port parser (completed): done");
    expect(plan.prompt).toContain("OOP Crew is off: use these results if they help");
    expect(plan.prompt).toContain("do not start new crew tasks");
    expect(plan.prompt).not.toContain("off by one");
    expect(plan.prompt).not.toContain("crew_wait");
    expect(followUpRound(plan.prompt)).toEqual({ round: 1, fixes: 0 });
    expect(
      planFollowUp({ current: { round: 0, fixes: 0 }, audits: ["x"], results: [], crewOff: true })
        .prompt,
    ).toBeNull();
  });

  it("stops asking for audit fixes after the limit but still delivers late reports", () => {
    const plan = planFollowUp({
      current: { round: 2, fixes: CREW_MAX_FIX_ROUNDS },
      audits: ["- still wrong"],
      results: [{ role: "worker", subject: "tests", status: "failed", report: null }],
    });
    expect(plan.dropped).toBe(true);
    expect(plan.prompt).not.toContain("still wrong");
    expect(followUpRound(plan.prompt)).toEqual({ round: 3, fixes: CREW_MAX_FIX_ROUNDS });
    expect(planFollowUp({ current: { round: 4, fixes: 0 }, audits: ["x"], results: [] })).toEqual({
      prompt: null,
      dropped: true,
    });
  });
});

describe("crew failure handling", () => {
  it("reads the report's last status line, treating a report without one as done", () => {
    expect(crewReportStatus("Changed a.ts.\nStatus: done")).toBe("done");
    expect(crewReportStatus("Wrote the parser; tests left.\n**Status:** partial")).toBe("partial");
    expect(crewReportStatus("Status: partial\nFinished after all.\nStatus: `blocked`")).toBe(
      "blocked",
    );
    expect(crewReportStatus("All good.")).toBe("done");
    expect(crewReportStatus(null)).toBe("done");
  });

  it("separates failures that need the provider fixed from ones a retry may clear", () => {
    expect(crewFailureKind("Insufficient balance or no resource package. Please recharge.")).toBe(
      "billing",
    );
    expect(crewFailureKind("Authentication required: Run `mcode login` and try again.")).toBe(
      "auth",
    );
    expect(crewFailureKind("Request failed with status 401")).toBe("auth");
    expect(crewFailureKind("the turn failed")).toBe("other");
    expect(crewFailureKind(undefined)).toBe("other");
  });

  it("classifies usage limits and model refusals from the real provider wording", () => {
    expect(
      crewFailureKind(
        "1308 Usage limit reached for 5 hour. Your limit will reset at 2026-11-04 21:15:17",
      ),
    ).toBe("limit");
    expect(crewFailureKind("rate limit exceeded, retry later")).toBe("limit");
    expect(crewFailureKind("rate_limit_error: slow down")).toBe("limit");
    expect(crewFailureKind("429 Too Many Requests")).toBe("limit");
    expect(crewFailureKind("You have hit your usage limit for this plan.")).toBe("limit");
    expect(crewFailureKind("Weekly quota reached for this workspace.")).toBe("limit");
    expect(crewFailureKind("The agent could not switch to model 'claude-haiku-5'")).toBe("model");
    expect(crewFailureKind("model gpt-9 is not available")).toBe("model");
    expect(crewFailureKind("model claude-opus does not exist")).toBe("model");
    expect(crewFailureKind("unknown model: x-unknown")).toBe("model");
    expect(crewFailureKind("invalid model name")).toBe("model");
    expect(crewFailureKind("no such model 'x-unknown'")).toBe("model");
    // The judgments that need a human still come first.
    expect(crewFailureKind("insufficient quota")).toBe("billing");
    expect(crewFailureKind("401 unauthorized")).toBe("auth");
    expect(crewFailureKind("the turn failed")).toBe("other");
    expect(crewFailureKind("HTTP 429: slow down")).toBe("limit");
    // A bare number or a model context server is not a limit or a refused model.
    expect(crewFailureKind("TypeError at app.js:429:12")).toBe("other");
    expect(crewFailureKind("exit code 1308")).toBe("other");
    expect(crewFailureKind("model context protocol server not found")).toBe("other");
  });

  it.each([
    // Real usage and rate limits, in the providers' own wording.
    ["Claude usage limit reached. Send the message again once the limit resets.", "limit"],
    ["Codex usage limit reached. The weekly limit resets in 5d 5h.", "limit"],
    ["You've hit your limit", "limit"],
    ["You've hit your usage limit.", "limit"],
    ["5-hour limit reached", "limit"],
    ["Weekly limit exceeded", "limit"],
    ["API Error: 429 Too Many Requests", "limit"],
    ["status 429", "limit"],
    // A limit on one request or resource is not the account running dry.
    ["Prompt is too long: context limit exceeded", "other"],
    ["max_output_tokens limit reached", "other"],
    ["git push rejected: repository size limit exceeded", "other"],
    ["API Error: 400 context length exceeded: input limit exceeded", "other"],
    // The provider refusing one model.
    ["model not found", "model"],
    ["The model `gpt-9` does not exist or you do not have access to it.", "model"],
    ["model: claude-x is not available", "model"],
    ["Your key does not have access to model gpt-9", "model"],
    // A tool that is missing is not a refused model.
    ["The model tried to run rg but ripgrep: command not found", "other"],
    ["model context protocol server not found", "other"],
  ] as const)("reads %j as %s", (error, kind) => {
    expect(crewFailureKind(error)).toBe(kind);
  });

  it("names the limit window an error mentions, without reading its reset time", () => {
    expect(
      crewLimitWindowName(
        "1308 Usage limit reached for 5 hour. Your limit will reset at 2026-11-04 21:15:17",
      ),
    ).toBe("5-hour");
    expect(crewLimitWindowName("5-hour limit reached")).toBe("5-hour");
    expect(crewLimitWindowName("five hour window is exhausted")).toBe("5-hour");
    expect(crewLimitWindowName("You are out of weekly capacity.")).toBe("weekly");
    expect(crewLimitWindowName("Limit resets in 7 day.")).toBe("weekly");
    expect(crewLimitWindowName("too many requests")).toBeNull();
    expect(crewLimitWindowName(undefined)).toBeNull();
  });

  it("asks crew members for a status line before the task text", () => {
    const prompt = delegatePrompt({ role: "worker", leadTitle: "Fix login", task: "Add tests" });
    expect(prompt).toContain("`Status: partial`");
    expect(prompt.endsWith("Add tests")).toBe(true);
  });
});

describe("auditPrompt", () => {
  it("judges the change against the user's request and keeps hardening non-blocking", () => {
    const prompt = auditPrompt({
      leadTitle: "Fix fetchAll",
      files: ["src/fetchAll.js"],
      request: "Keep ids in order and run at most three requests at once.",
    });
    expect(prompt).toContain(
      "The user asked:\nKeep ids in order and run at most three requests at once.",
    );
    expect(prompt).toContain("Hardening beyond the request");
    expect(prompt).toContain("`Verdict: needs changes` only when a blocking problem remains");
  });

  it("hands the auditor the thread's diff in a fence, and only when it fits", () => {
    const fence = (size: number) => "`".repeat(size);
    const diff = "diff --git a/src/a.js b/src/a.js\n+export const a = 1;\n";
    const withDiff = auditPrompt({
      leadTitle: "Add a",
      files: ["src/a.js"],
      request: "Add a",
      diff,
    });
    expect(withDiff).toContain(["", `${fence(3)}diff`, diff.trimEnd(), fence(3), ""].join("\n"));
    const without = auditPrompt({ leadTitle: "Add a", files: ["src/a.js"], request: "Add a" });
    expect(without).not.toContain(`${fence(3)}diff`);
    expect(auditDiff("+a\n")).toBe("+a\n");
    expect(auditDiff("  \n")).toBeNull();
    expect(auditDiff("x".repeat(AUDIT_DIFF_MAX_CHARS))).not.toBeNull();
    expect(auditDiff("x".repeat(AUDIT_DIFF_MAX_CHARS + 1))).toBeNull();
  });

  it("fences a diff longer than any backtick run inside it", () => {
    const fence = (size: number) => "`".repeat(size);
    const diff = [`+${fence(3)}js`, "+x", `+${fence(3)}`, ""].join("\n");
    const prompt = auditPrompt({ leadTitle: "Docs", files: ["README.md"], request: null, diff });
    expect(prompt).toContain(["", `${fence(4)}diff`, diff.trimEnd(), fence(4), ""].join("\n"));
  });

  it("tells crew follow-ups apart from messages the user wrote", () => {
    const plan = planFollowUp({ current: { round: 0, fixes: 0 }, audits: ["x"], results: [] });
    expect(isCrewFollowUp(plan.prompt ?? "")).toBe(true);
    expect(isCrewFollowUp("Please fix the parser")).toBe(false);
  });
});

describe("clipCrewReport", () => {
  const LIMIT = 6_000;

  it("leaves a report within the limit untouched", () => {
    expect(clipCrewReport("short\nStatus: done", LIMIT)).toBe("short\nStatus: done");
  });

  it("keeps the closing Status and Verdict lines of a report over the limit", () => {
    const body = "finding detail. ".repeat(1_000);
    const report = `${body}\nStatus: partial\nVerdict: needs changes`;
    const clipped = clipCrewReport(report, LIMIT);

    expect(clipped.length).toBeLessThanOrEqual(LIMIT);
    expect(clipped).toContain("…[truncated]…");
    expect(clipped.startsWith("finding detail.")).toBe(true);
    expect(crewReportStatus(clipped)).toBe("partial");
    expect(auditVerdict(clipped)).toBe("needs-changes");
    // The head-only cut this replaces lost both lines.
    expect(crewReportStatus(report.slice(0, LIMIT))).toBe("done");
    expect(auditVerdict(report.slice(0, LIMIT))).toBeNull();
  });
});

describe("delegation sections", () => {
  it("renders the task first and only the sections the lead gave", () => {
    const bare = delegatePrompt({ role: "worker", leadTitle: "Fix login", task: "Add tests" });
    expect(bare).not.toContain("SCOPE");
    expect(bare).not.toContain("VERIFY");
    expect(bare).not.toContain("DONE WHEN");
    const full = delegatePrompt({
      role: "worker",
      leadTitle: "Fix login",
      task: "Add tests",
      writeScope: ["src/auth/", "docs/login.md"],
      verify: "vp test run src/auth",
      doneWhen: "every login case has a test",
    });
    expect(full).toContain("TASK:\nAdd tests\n\nSCOPE");
    expect(full).toContain("- src/auth/\n- docs/login.md");
    expect(full).toContain(
      "VERIFY (run exactly this before you report, and put its result in your report):\nvp test run src/auth",
    );
    expect(full).toContain("DONE WHEN:\nevery login case has a test");
    // The static preamble does not depend on the task, so providers can cache it.
    expect(full.slice(0, full.indexOf("TASK:"))).toBe(bare.slice(0, bare.indexOf("TASK:")));
  });
});

describe("delegation with a TODO list", () => {
  const base = { role: "worker", leadTitle: "Fix login", task: "Add tests" } as const;
  const todos = assignTodos(["first", { text: "second", check: { command: "vp test run a" } }]);

  it("reads exactly as before without a list", () => {
    expect(delegatePrompt({ ...base, todos: [] })).toBe(delegatePrompt(base));
    expect(delegatePrompt({ ...base, todos: undefined })).toBe(delegatePrompt(base));
  });

  it("puts the list after every other section so the cacheable preamble is unchanged", () => {
    const full = {
      ...base,
      writeScope: ["src/"],
      verify: "vp test run a",
      doneWhen: "all green",
    };
    const without = delegatePrompt(full);
    const withList = delegatePrompt({ ...full, todos });
    expect(withList.startsWith(without)).toBe(true);
    expect(withList.slice(without.length)).toContain("- t1: first\n- t2: second");
    expect(withList.slice(0, withList.indexOf("TASK:"))).toBe(
      without.slice(0, without.indexOf("TASK:")),
    );
  });
});

describe("a finished task with a TODO list", () => {
  const none = { pending: 0, failed: 0, blocked: 0 };

  it("is partial while items are pending, failing, or blocked, and claimed ones do not count", () => {
    expect(withTodoOutcome("completed", none)).toBe("completed");
    expect(withTodoOutcome("completed", undefined)).toBe("completed");
    for (const open of [{ pending: 1 }, { failed: 1 }, { blocked: 1 }]) {
      expect(withTodoOutcome("completed", { ...none, ...open })).toBe("partial");
    }
    expect(withTodoOutcome("blocked", { ...none, pending: 2 })).toBe("blocked");
    expect(withTodoOutcome("failed", { ...none, pending: 2 })).toBe("failed");
  });

  it("turns a member's own done into partial, and keeps partial and blocked as they are", () => {
    const open = { ...none, failed: 1 };
    expect(crewMemberOutcome("worker", "completed", "Status: done", open).status).toBe("partial");
    expect(crewMemberOutcome("worker", "completed", "Status: blocked", open).status).toBe(
      "blocked",
    );
    expect(crewMemberOutcome("worker", "completed", "Status: done", none).status).toBe("completed");
    expect(crewMemberOutcome("worker", "interrupted", "Status: done", open).status).toBe(
      "interrupted",
    );
    expect(crewMemberOutcome("auditor", "completed", "Verdict: approve", open).status).toBe(
      "completed",
    );
  });
});

describe("write scope overlap", () => {
  const running = (taskId: string, writeScope?: string[], isolated?: boolean) => ({
    taskId,
    subject: `task ${taskId}`,
    writeScope,
    isolated,
  });
  const overlapIds = (scope: string[], tasks: ReturnType<typeof running>[]) =>
    overlappingWriteScopes(scope, tasks).map((overlap) => overlap.taskId);

  it("overlaps a path with itself and with a directory that contains it", () => {
    expect(overlapIds(["src/a.ts"], [running("1", ["src/a.ts"])])).toEqual(["1"]);
    expect(overlapIds(["src/"], [running("1", ["src/auth/login.ts"])])).toEqual(["1"]);
    expect(overlapIds(["src/auth/login.ts"], [running("1", ["src"])])).toEqual(["1"]);
  });

  it("matches on path segments, not on string prefixes", () => {
    expect(overlapIds(["src/auth/"], [running("1", ["src/author/"])])).toEqual([]);
    expect(overlapIds(["src/a.ts"], [running("1", ["src/a.tsx"])])).toEqual([]);
    expect(overlapIds(["docs/"], [running("1", ["src/"])])).toEqual([]);
  });

  it("ignores a leading ./ and trailing globs", () => {
    expect(overlapIds(["./src/auth/"], [running("1", ["src/auth/login.ts"])])).toEqual(["1"]);
    expect(overlapIds(["src/auth/**"], [running("1", ["src/auth/login.ts"])])).toEqual(["1"]);
    expect(overlapIds(["src/*"], [running("1", ["src/a/b.ts"])])).toEqual(["1"]);
    expect(overlapIds(["src/auth/*.ts"], [running("1", ["src/other/"])])).toEqual([]);
    expect(overlapIds(["**"], [running("1", ["anything/at/all.ts"])])).toEqual(["1"]);
  });

  it("leaves out running tasks that work in their own worktree", () => {
    expect(
      overlapIds(["src/"], [running("1", ["src/a.ts"], true), running("2", ["src/b.ts"], false)]),
    ).toEqual(["2"]);
  });

  it("does not count a running task without a scope as an overlap", () => {
    expect(overlapIds(["src/"], [running("1"), running("2", [])])).toEqual([]);
    expect(overlapIds([], [running("1", ["src/"])])).toEqual([]);
  });

  it("names each overlapping task and the paths in the warning", () => {
    const overlaps = overlappingWriteScopes(
      ["src/auth/", "docs/"],
      [running("1", ["src/auth/login.ts", "src/auth/"]), running("2", ["lib/"])],
    );
    expect(overlaps).toEqual([
      {
        taskId: "1",
        subject: "task 1",
        paths: [
          { mine: "src/auth/", theirs: "src/auth/login.ts" },
          { mine: "src/auth/", theirs: "src/auth/" },
        ],
      },
    ]);
    const warning = writeScopeWarning(overlaps)!;
    expect(warning).toContain("task 1 (task 1): src/auth/ vs src/auth/login.ts, src/auth/");
    expect(warning).toContain("crew_wait");
    expect(warning).toContain("narrow the scopes");
    expect(writeScopeWarning([])).toBeNull();
  });
});

describe("structured reports", () => {
  const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const member = {
    status: "partial",
    summary: "Parser ported; tests left.",
    changedFiles: ["src/parser.ts"],
    verification: { command: "vp test run src/parser.test.ts", passed: false },
    findings: [
      { severity: "P1", confidence: 0.8, title: "Off by one", file: "src/parser.ts", line: 12 },
    ],
  };

  it("reads the last json block of a reply and prefers its status over the text line", () => {
    const reply = `Ported the parser.\nStatus: done\n${json({ status: "blocked", summary: "old" })}\n${json(member)}`;
    expect(parseCrewReport(reply)).toEqual(member);
    expect(crewReportStatus(reply)).toBe("partial");
    expect(crewMemberOutcome("worker", "completed", reply)).toEqual({
      status: "partial",
      report: member,
    });
  });

  it("fills in the lists a crew member left out", () => {
    expect(parseCrewReport(json({ status: "done", summary: "All done." }))).toEqual({
      status: "done",
      summary: "All done.",
      changedFiles: [],
      verification: null,
      findings: [],
    });
  });

  it("falls back to the text lines when the json is malformed or the wrong shape", () => {
    const text = "Did part of it.\nStatus: partial\n";
    for (const block of [
      "```json\n{not json\n```",
      json({ status: "finished", summary: "x" }),
      json({ summary: "no status" }),
      json({
        status: "done",
        summary: "x",
        findings: [{ severity: "P9", confidence: 2, title: "t" }],
      }),
    ]) {
      expect(parseCrewReport(`${text}${block}`)).toBeNull();
      expect(crewReportStatus(`${text}${block}`)).toBe("partial");
    }
  });

  it("leaves text-only replies exactly as before", () => {
    expect(parseCrewReport("Changed a.ts.\nStatus: blocked")).toBeNull();
    expect(parseCrewReport(null)).toBeNull();
    expect(crewReportStatus("Changed a.ts.\nStatus: blocked")).toBe("blocked");
    expect(crewMemberOutcome("worker", "completed", "All good.")).toEqual({
      status: "completed",
      report: null,
    });
    expect(crewMemberOutcome("worker", "interrupted", `Status: partial\n${json(member)}`)).toEqual({
      status: "interrupted",
      report: null,
    });
    expect(crewMemberOutcome("auditor", "completed", json(member))).toEqual({
      status: "completed",
      report: null,
    });
  });

  it("keeps the most severe findings when a report has too many", () => {
    const findings = [
      ...Array.from({ length: CREW_REPORT_MAX_FINDINGS }, (_, index) => ({
        severity: "P3",
        confidence: 0.5,
        title: `nit ${index}`,
      })),
      { severity: "P0", confidence: 0.9, title: "data loss" },
    ];
    const parsed = parseCrewReport(json({ status: "done", summary: "x", findings }))!;
    expect(parsed.findings).toHaveLength(CREW_REPORT_MAX_FINDINGS);
    expect(parsed.findings[0]?.title).toBe("data loss");
  });

  it("reads the auditor's verdict from its json review when the Verdict line is missing", () => {
    const review = (verdict: string) => `Looks right.\n${json({ verdict, summary: "ok" })}`;
    expect(auditVerdict(review("approve"))).toBe("approve");
    expect(auditVerdict(review("needs changes"))).toBe("needs-changes");
    // The json wins over a contradicting text line.
    expect(
      auditVerdict(`Verdict: needs changes\n${json({ verdict: "approve", summary: "ok" })}`),
    ).toBe("approve");
    // A review of the wrong shape falls back to the text line.
    expect(
      auditVerdict(`Verdict: needs changes\n${json({ verdict: "maybe", summary: "ok" })}`),
    ).toBe("needs-changes");
    expect(parseAuditReport(review("approve"))).toEqual({
      verdict: "approve",
      summary: "ok",
      findings: [],
      preExistingFailures: [],
    });
  });

  it("approves a review that asks for changes only because of failures that predate the turn", () => {
    const provenBlocking = {
      severity: "P1",
      confidence: 0.9,
      title: "Breaks login",
      proven: true,
      level: "ran",
      evidence: "login.test.ts fails",
    };
    const nit = { severity: "P3", confidence: 0.4, title: "Naming" };
    const review = (findings: object[], preExistingFailures: string[]) =>
      json({ verdict: "needs changes", summary: "x", findings, preExistingFailures });
    expect(auditVerdict(review([], ["vp test run: fails in legacy.test.ts"]))).toBe("approve");
    expect(auditVerdict(review([nit], ["tsc: 12 errors in src/old.ts"]))).toBe("approve");
    expect(auditVerdict(review([provenBlocking], ["tsc: 12 errors in src/old.ts"]))).toBe(
      "needs-changes",
    );
    expect(auditVerdict(review([], []))).toBe("needs-changes");
  });
});

describe("proven audit findings", () => {
  const json = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const unproven = { severity: "P1", confidence: 0.9, title: "Might break login" };
  const proven = (extra: object = {}) => ({
    ...unproven,
    proven: true,
    level: "ran",
    evidence: "vp test run login.test.ts: 1 failed, expected 200 got 500",
    ...extra,
  });
  const review = (findings: object[], extra: object = {}) =>
    json({ verdict: "needs changes", summary: "x", findings, ...extra });

  it("does not block on a P1 the auditor could only point at", () => {
    expect(auditVerdict(review([unproven]))).toBe("approve");
    expect(auditVerdict(review([{ ...unproven, proven: false, level: "line" }]))).toBe("approve");
  });

  it("blocks on a P0 or P1 proven by tracing, running, or the app", () => {
    for (const level of ["traced", "ran", "app"]) {
      expect(auditVerdict(review([proven({ level })]))).toBe("needs-changes");
    }
    expect(auditVerdict(review([proven({ severity: "P0" })]))).toBe("needs-changes");
  });

  it("treats proven true with level said or line, or without evidence, as unproven", () => {
    expect(auditVerdict(review([proven({ level: "said" })]))).toBe("approve");
    expect(auditVerdict(review([proven({ level: "line" })]))).toBe("approve");
    expect(auditVerdict(review([proven({ level: undefined })]))).toBe("approve");
    expect(auditVerdict(review([proven({ evidence: undefined })]))).toBe("approve");
    expect(auditVerdict(review([proven({ evidence: "  " })]))).toBe("approve");
    const parsed = parseAuditReport(review([proven({ level: "line" })]))!;
    expect(parsed.findings[0]?.proven).toBe(false);
  });

  it("does not block on a proven P2 or P3", () => {
    expect(auditVerdict(review([proven({ severity: "P2" })]))).toBe("approve");
  });

  it("still blocks a needs-changes review that lists no findings", () => {
    expect(auditVerdict(review([]))).toBe("needs-changes");
  });

  it("keeps the Verdict line path and the pre-existing exception as before", () => {
    expect(auditVerdict("Verdict: needs changes")).toBe("needs-changes");
    expect(auditVerdict(review([unproven], { preExistingFailures: ["tsc: old"] }))).toBe("approve");
    expect(auditVerdict(review([proven()], { preExistingFailures: ["tsc: old"] }))).toBe(
      "needs-changes",
    );
  });

  it("reads a report that has none of the new fields, and clips long evidence", () => {
    const old = parseAuditReport(
      json({
        verdict: "needs changes",
        summary: "x",
        findings: [{ severity: "P2", confidence: 0.5, title: "t" }],
      }),
    )!;
    expect(old.findings[0]).toEqual({ severity: "P2", confidence: 0.5, title: "t" });
    const long = parseAuditReport(review([proven({ evidence: "e".repeat(900) })]))!;
    expect(long.findings[0]?.evidence?.length).toBeLessThanOrEqual(300);
  });

  it("lists proven findings before unproven ones of the same severity", () => {
    const parsed = parseAuditReport(review([unproven, proven({ title: "Proven one" })]))!;
    expect(parsed.findings.map((finding) => finding.title)).toEqual([
      "Proven one",
      "Might break login",
    ]);
  });

  it("reads the safety fact", () => {
    const parsed = parseAuditReport(
      json({
        verdict: "approve",
        summary: "ok",
        safetyFact: { fact: "only drops dead cache entries", level: "ran", evidence: "ran x" },
      }),
    )!;
    expect(parsed.safetyFact?.level).toBe("ran");
  });

  it("asks for proof by running code, or at least a traced failing input", () => {
    const prompt = auditPrompt({ leadTitle: "Fix login", files: ["a.ts"], request: null });
    expect(prompt).toContain("safetyFact");
    expect(prompt).toContain("Prove it by running real code when your tools allow it");
    expect(prompt).toContain("step-by-step trace through real file:line");
    expect(prompt).toContain("never blocks");
    expect(prompt).toContain("Do not report style, naming");
    expect(prompt).toContain("blocking problems are proven P0 or P1 findings");
  });

  it("tells the lead that unproven findings are leads, not defects", () => {
    const plan = planFollowUp({ current: { round: 0, fixes: 0 }, audits: ["x"], results: [] });
    expect(plan.prompt).toContain("Findings marked unproven are leads, not defects");
  });
});

describe("baseline-aware audit prompt", () => {
  it("hands the auditor the turn's snapshot refs and asks for a pre-existing list", () => {
    const prompt = auditPrompt({
      leadTitle: "Fix login",
      files: ["src/login.ts"],
      request: null,
      turnRefs: { from: "refs/t3/checkpoints/abc/turn/2", to: "refs/t3/checkpoints/abc/turn/3" },
    });
    expect(prompt).toContain(
      "git diff refs/t3/checkpoints/abc/turn/2 refs/t3/checkpoints/abc/turn/3 -- <path>",
    );
    expect(prompt).toContain("git show refs/t3/checkpoints/abc/turn/2:<path>");
    expect(prompt).toContain("preExistingFailures");
    expect(prompt).toContain("`Verdict: needs changes` only when a blocking problem remains");
  });

  it("tells the auditor to read the diff when no snapshot refs are known", () => {
    const prompt = auditPrompt({ leadTitle: "Fix login", files: ["src/login.ts"], request: null });
    expect(prompt).not.toContain("git diff refs/");
    expect(prompt).toContain("Read the diff to see whether the failing code was touched.");
    expect(prompt).toContain("preExistingFailures");
  });
});

describe("crew memory references", () => {
  const brief = delegatePrompt({ role: "worker", leadTitle: "Fix login", task: "Add tests" });

  it("adds one reference and one identifier-only record per memory behind the plain brief", () => {
    const { text, context } = withCrewMemoryReferences(brief, [
      { memoryId: "mem-1", selectedVersion: 3 },
      { memoryId: "mem-2", selectedVersion: 1 },
    ]);
    expect(text.startsWith(brief)).toBe(true);
    expect(text.match(/t3-context:\/\/v1\/memory\//g)?.length).toBe(2);
    expect(context?.records.map((record) => "payload" in record && record.payload)).toEqual([
      { memoryId: "mem-1", selectedVersion: 3 },
      { memoryId: "mem-2", selectedVersion: 1 },
    ]);
    // The brief is built without any memory input, so it can never carry a body.
    expect(brief).not.toContain("t3-context://");
  });

  it("leaves the brief untouched when there is no memory, and strips references for a retry", () => {
    expect(withCrewMemoryReferences(brief, [])).toEqual({ text: brief, context: undefined });
    const { text } = withCrewMemoryReferences(brief, [{ memoryId: "mem-1", selectedVersion: 1 }]);
    expect(withoutCrewMemoryReferences(text)).toBe(brief);
    expect(withoutCrewMemoryReferences(brief)).toBe(brief);
  });
});
