import {
  ProviderDriverKind,
  ProviderInstanceId,
  EventId,
  type OwnedResultCoverageV1,
  type OwnedResultUsageTrailingV1,
  type OwnedResultUsageV1,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatResultUsageBucketLine,
  formatResultUsageCoverageLine,
  formatResultUsageRowLines,
  formatResultUsageTrailingLine,
  RESULT_USAGE_HEADLINE,
  RESULT_USAGE_SCOPE_NOTE,
  RESULT_USAGE_SNAPSHOT_NOTE,
  RESULT_USAGE_STATE_COPY,
} from "./resultUsageText";

const zeroCoverage = (): OwnedResultCoverageV1 => ({
  complete: 0,
  partial: 0,
  unavailable: 0,
  ambiguous: 0,
  conflictTainted: 0,
  unscoped: 0,
  unrecorded: 0,
  lateUnattributed: 0,
});

function measuredRow(
  overrides: Partial<OwnedResultUsageV1> & {
    readonly cached?: { sum: number; reportedTurns: number };
    readonly cacheCreation?: { sum: number; reportedTurns: number };
    readonly reasoning?: { sum: number; reportedTurns: number };
  } = {},
): OwnedResultUsageV1 {
  const {
    cached = { sum: 300, reportedTurns: 1 },
    cacheCreation = { sum: 0, reportedTurns: 0 },
    reasoning = { sum: 40, reportedTurns: 2 },
    ...rest
  } = overrides;
  return {
    attemptId: "attempt-1",
    revision: 2,
    finalEventId: EventId.make("evt-final"),
    finalSequence: 7,
    anchorSequence: 6,
    segment: { fromSequenceExclusive: 5, toSequenceExclusive: 6 },
    inputs: 2,
    otherAttempts: 1,
    recordedSpan: { recordedSpanMs: 80_000, timeBasis: "recorded-event-timestamps" },
    checksMs: 30_000,
    usage: {
      status: "measured",
      coverage: { ...zeroCoverage(), complete: 2, unrecorded: 1 },
      buckets: [
        {
          scope: {
            driver: ProviderDriverKind.make("claudeAgent"),
            instanceId: ProviderInstanceId.make("inst-1"),
            nativeConversationId: null,
          },
          reportedCompleteSubtotal: {
            completeTurns: 2,
            inputTokens: 1000,
            outputTokens: 500,
            cachedInputTokens: cached,
            cacheCreationTokens: cacheCreation,
            reasoningTokens: reasoning,
          },
        },
      ],
      childFrames: 3,
      legacyChildFrames: 0,
    },
    billedCost: "unknown",
    parentChildOverlap: "unknown",
    ...rest,
  };
}

function unmeasurableRow(
  reason: Extract<OwnedResultUsageV1["usage"], { status: "unmeasurable" }>["reason"],
): OwnedResultUsageV1 {
  return measuredRow({
    recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
    checksMs: null,
    usage: { status: "unmeasurable", reason },
  });
}

/** Narrows the measured usage body without weakening the contract union. */
function measuredUsage(
  row: OwnedResultUsageV1,
): Extract<OwnedResultUsageV1["usage"], { status: "measured" }> {
  if (row.usage.status !== "measured") throw new Error("fixture expected a measured row");
  return row.usage;
}

const ALL_ROWS: ReadonlyArray<OwnedResultUsageV1> = [
  measuredRow(),
  measuredRow({
    recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
    checksMs: null,
  }),
  unmeasurableRow("activity-during-attempt"),
  unmeasurableRow("turn-active-at-attempt"),
  unmeasurableRow("revision-conflict"),
  unmeasurableRow("invalid-receipt-or-window"),
  unmeasurableRow("unresolved-ownership-or-history"),
];

describe("result usage disclosure copy", () => {
  it("labels the recorded snapshot scope without provider-account claims", () => {
    expect(RESULT_USAGE_HEADLINE).toBe("이 스레드 · 이 서버가 기록한 값");
    expect(RESULT_USAGE_SCOPE_NOTE).toContain("제공자 계정 사용량과 범위가 다릅니다");
    expect(RESULT_USAGE_SNAPSHOT_NOTE).toContain("읽은 시점까지의 기록 기준");
  });

  it("renders measured numbers with per-bucket in/out and cache k/n reporting", () => {
    const lines = formatResultUsageRowLines(measuredRow());
    expect(lines).toContain("입력 2회 · 다른 시도 1회");
    expect(lines).toContain("검사 실행 시간: 30초");
    expect(lines.join("\n")).toContain("입력 1000 · 출력 500");
    expect(lines.join("\n")).toContain("캐시 입력 300(1/2턴 보고)");
    expect(lines.join("\n")).toContain("추론 40(2/2턴 보고)");
    expect(lines.join("\n")).toContain("대화 미확인");
    expect(lines).toContain("하위 작업 3 frame · 미포함(중복 여부 불명)");
    expect(lines).toContain("비용: 알 수 없음(청구액 기록 없음)");
  });

  it("distinguishes unreported cache dimensions from an explicit zero", () => {
    const unreported = formatResultUsageBucketLine(measuredUsage(measuredRow()).buckets[0]!);
    expect(unreported).toContain("캐시 생성 미보고");
    const explicitZero = formatResultUsageBucketLine(
      measuredUsage(measuredRow({ cached: { sum: 0, reportedTurns: 2 } })).buckets[0]!,
    );
    expect(explicitZero).toContain("캐시 입력 0(2/2턴 보고)");
    expect(explicitZero).not.toContain("캐시 입력 미보고");
  });

  it("keeps missing time measurements distinct from zero", () => {
    const lines = formatResultUsageRowLines(
      measuredRow({
        recordedSpan: { recordedSpanMs: null, timeBasis: "recorded-event-timestamps" },
        checksMs: null,
      }),
    );
    expect(lines).toContain("검사 실행 시간: 측정 없음");
    expect(lines).toContain("기록 시각 차이: 측정 없음");
    expect(lines.join("\n")).not.toContain("검사 실행 시간: 0");
    expect(lines.join("\n")).not.toContain("기록 시각 차이: 0");
  });

  it("labels the recorded span as timestamp difference, not execution time", () => {
    const lines = formatResultUsageRowLines(measuredRow());
    expect(lines).toContain(
      "기록 시각 차이: 1분 20초(기록된 시각의 차이이며 실제 실행 시간이 아님)",
    );
  });

  it("gives one sentence per unmeasurable reason and no numbers", () => {
    for (const row of ALL_ROWS.filter((row) => row.usage.status === "unmeasurable")) {
      const lines = formatResultUsageRowLines(row);
      expect(lines).toHaveLength(4);
      expect(lines[3]!).toContain("사용량 확정 불가 · ");
      expect(lines.join("\n")).not.toContain("입력 1000");
      expect(lines.join("\n")).not.toContain("비용");
      expect(lines.join("\n")).not.toContain("하위 작업");
    }
  });

  it("renders coverage counts including late unattributed exclusions", () => {
    const line = formatResultUsageCoverageLine({
      ...zeroCoverage(),
      complete: 2,
      unrecorded: 1,
      lateUnattributed: 3,
    });
    expect(line).toBe(
      "턴 범위 · 완전 2 · 부분 0 · 불가 0 · 모호 0 · 오염 0 · 범위 밖 0 · 미기록 1 · 늦은 관측(제외) 3",
    );
  });

  it("shows trailing counts only when anything was observed", () => {
    const empty: OwnedResultUsageTrailingV1 = {
      inputs: 0,
      otherAttempts: 0,
      coverage: zeroCoverage(),
    };
    expect(formatResultUsageTrailingLine(empty)).toBeNull();
    const line = formatResultUsageTrailingLine({
      inputs: 2,
      otherAttempts: 1,
      coverage: { ...zeroCoverage(), unrecorded: 1 },
    });
    expect(line).toContain("마지막 결과 이후 · 입력 2회 · 다른 시도 1회");
    expect(line).toContain("미기록 1");
  });

  it("never claims totals, spending, or currency", () => {
    const forbidden = /total|spent|\$|합계|총액/i;
    for (const row of ALL_ROWS) {
      const text = formatResultUsageRowLines(row).join("\n");
      expect(forbidden.test(text)).toBe(false);
    }
    expect(forbidden.test(formatResultUsageCoverageLine(zeroCoverage()))).toBe(false);
    const fixedCopy = RESULT_USAGE_HEADLINE + RESULT_USAGE_SCOPE_NOTE + RESULT_USAGE_SNAPSHOT_NOTE;
    expect(forbidden.test(fixedCopy)).toBe(false);
    for (const copy of Object.values(RESULT_USAGE_STATE_COPY)) {
      expect(forbidden.test(copy)).toBe(false);
    }
  });

  it("reports zero inputs without erasing them", () => {
    const lines = formatResultUsageRowLines(measuredRow({ inputs: 0, otherAttempts: 0 }));
    expect(lines).toContain("입력 0회 · 다른 시도 0회");
  });
});
