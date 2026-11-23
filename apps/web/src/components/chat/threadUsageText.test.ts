import { ThreadId, type ThreadUsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow";
import { changeLanguage } from "../../state/menuLanguage";
import { formatCrewAuditFooter, formatThreadUsageFooter, shortModelName } from "./threadUsageText";
const totals: ThreadUsageSummary["totals"] = {
  inputTokens: 1000,
  outputTokens: 100,
  cachedInputTokens: { sum: 300, reportedTurns: 1 },
  cacheCreationTokens: { sum: 200, reportedTurns: 1 },
  turns: 1,
  cacheRate: 0.3,
  cost: { kind: "unknown" },
};
const summary: ThreadUsageSummary = {
  threadId: ThreadId.make("thread"),
  status: "ok",
  totals,
  models: [
    { ...totals, model: "opus", driver: "claudeAgent", cost: { kind: "reported", usd: 4.12 } },
    { ...totals, model: "astra", driver: "codex", cost: { kind: "estimated", usd: 0.31 } },
    { ...totals, model: "glm", driver: "opencode" },
  ],
};
describe("thread usage footer text", () => {
  it("labels cache and all cost kinds in Korean", () => {
    changeLanguage("ko");
    expect(formatThreadUsageFooter(summary, null)).toBe(
      "opus $4.12 캐시 30% · astra ≈$0.31 캐시 30% · glm 비용 알 수 없음 캐시 30%",
    );
  });
  it("names the turn only when the server answered for one", () => {
    changeLanguage("en");
    expect(
      formatThreadUsageFooter({ ...summary, scope: "turn", requestAggregated: true }, null),
    ).toBe(
      "This request · opus $4.12 cache 30% · astra ≈$0.31 cache 30% · glm Cost unknown cache 30%",
    );
    changeLanguage("ko");
    expect(
      formatThreadUsageFooter({ ...summary, scope: "turn", requestAggregated: true }, null),
    ).toBe(
      "이번 요청 · opus $4.12 캐시 30% · astra ≈$0.31 캐시 30% · glm 비용 알 수 없음 캐시 30%",
    );
    // A whole-thread answer (or an old server without a scope) stays unlabelled.
    expect(formatThreadUsageFooter({ ...summary, scope: "thread" }, null)).not.toContain("턴");
    expect(formatThreadUsageFooter(summary, null)).not.toContain("턴");
  });
  it("does not label a legacy per-turn summary as a whole request", () => {
    changeLanguage("en");
    expect(formatThreadUsageFooter({ ...summary, scope: "turn" }, null)).not.toContain(
      "This request",
    );
  });
  it("says a row that measured no turn had no usage reported", () => {
    changeLanguage("en");
    // A crew model on a provider that never reports usage: the server lists it
    // with no turns, so the row says nothing was measured rather than pricing it.
    const withCrew: ThreadUsageSummary = {
      ...summary,
      models: [
        { ...totals, model: "opus", driver: "claudeAgent", cost: { kind: "reported", usd: 4.12 } },
        { ...totals, turns: 0, model: "cursor", driver: "", cost: { kind: "unknown" } },
      ],
    };
    expect(formatThreadUsageFooter(withCrew, null)).toBe(
      "opus $4.12 cache 30% · cursor Usage not reported",
    );
    changeLanguage("ko");
    expect(formatThreadUsageFooter(withCrew, null)).toBe(
      "opus $4.12 캐시 30% · cursor 사용량 미보고",
    );
  });

  it("shows lead and crew usage independently without duplicating context", () => {
    changeLanguage("en");
    const request: ThreadUsageSummary = {
      ...summary,
      scope: "turn",
      requestAggregated: true,
      models: [
        {
          ...totals,
          model: "claude-opus-5-5",
          driver: "claudeAgent",
          cacheRate: 0.92,
          cost: { kind: "estimated", usd: 4.12 },
          context: { usedTokens: 182000, maxTokens: 1000000 },
        },
        {
          ...totals,
          model: "gpt-6.2-sol",
          driver: "codex",
          cacheRate: 0.85,
          cost: { kind: "estimated", usd: 0.4 },
          context: { usedTokens: 64000, maxTokens: 400000 },
        },
        { ...totals, model: "gpt-6.2-astra", driver: "codex", turns: 0 },
      ],
    };
    const context = deriveLatestContextWindowSnapshot([
      {
        kind: "context-window.updated",
        payload: { usedTokens: 2000, maxTokens: 10000 },
        createdAt: "2026-01-01T00:00:00Z",
      } as Parameters<typeof deriveLatestContextWindowSnapshot>[0][number],
    ]);
    expect(formatThreadUsageFooter(request, context)).toBe(
      "This request · opus-5.5 ≈$4.12 cache 92% ctx 182k/1m · gpt-6.2-sol ≈$0.40 cache 85% ctx 64k/400k · gpt-6.2-astra Usage not reported",
    );
    expect(
      formatThreadUsageFooter(
        {
          ...request,
          models: [
            {
              ...totals,
              model: "gpt-6.2-astra",
              driver: "codex",
              turns: 0,
              context: { usedTokens: 2000, maxTokens: 10000 },
            },
          ],
        },
        null,
      ),
    ).toBe("This request · gpt-6.2-astra Usage not reported ctx 2k/10k");
    // The thread's latest context may come from an earlier request.
    expect(
      formatThreadUsageFooter(
        { ...summary, scope: "turn", requestAggregated: true, models: [] },
        context,
      ),
    ).toBe("This request");
    expect(formatThreadUsageFooter({ ...summary, models: [] }, context)).toBe("ctx 2k/10k");
    expect(
      formatThreadUsageFooter(
        {
          ...request,
          models: [
            {
              ...request.models[0]!,
              cacheRate: null,
              context: { usedTokens: 500, maxTokens: null },
            },
          ],
        },
        null,
      ),
    ).toBe("This request · opus-5.5 ≈$4.12 ctx 500");
  });

  it("hides absent cache reporting and overflow summaries", () => {
    expect(formatThreadUsageFooter(null, null)).toBe("");
    expect(formatThreadUsageFooter({ ...summary, status: "too-large" }, null)).toBe("");
    expect(
      formatThreadUsageFooter(
        { ...summary, models: [], totals: { ...totals, cacheRate: null } },
        null,
      ),
    ).toBe("");
  });
});

it("shows the audit with an optional model", () => {
  changeLanguage("ko");
  expect(formatCrewAuditFooter({})).toBe("감사자가 이 답변을 검토하는 중");
  expect(formatCrewAuditFooter({ model: "astra" })).toBe("감사자가 이 답변을 검토하는 중 · astra");
});

describe("short model names", () => {
  it.each([
    ["builtin:zai-coding-plan\\GLM-5.3", "GLM-5.3"],
    ["provider/claude-opus-5-5", "opus-5.5"],
    ["claude-sonnet-4-6[1m]", "sonnet-4.6[1m]"],
    ["claude-haiku-5-5-20260101", "haiku-5.5"],
    ["claude-opus-5-5-latest", "opus-5.5"],
    ["gpt-6.2-sol", "gpt-6.2-sol"],
    ["gpt-6-astra", "gpt-6-astra"],
    ["deepseek-v41-flash-1017", "deepseek-v41-flash-1017"],
    ["gemini-4-pro", "gemini-4-pro"],
  ])("%s becomes %s", (model, expected) => {
    expect(shortModelName(model)).toBe(expected);
  });
});
