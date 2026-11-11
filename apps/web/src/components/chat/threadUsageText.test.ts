import { ThreadId, type ThreadUsageSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { changeLanguage } from "../../state/menuLanguage";
import { formatCrewAuditFooter, formatThreadUsageFooter } from "./threadUsageText";
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
      "캐시 30.0% · opus $4.12 · astra ≈$0.31 · glm 비용 알 수 없음",
    );
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
