import type {
  OwnedMainUsageBucketV1,
  OwnedResultCoverageV1,
  OwnedResultUnmeasurableReason,
  OwnedResultUsageTrailingV1,
  OwnedResultUsageV1,
} from "@t3tools/contracts";
import type { ResultUsageDisclosureState } from "../../state/resultUsage";

/**
 * Fixed Korean copy for the passed-record usage disclosure (U-OWN-2 web
 * slice). Honest labels only: recorded snapshot of this thread on this
 * server, recorded timestamp spans are not execution time, cost is unknown,
 * child frames are excluded with unknown overlap, and nothing is ever summed
 * across buckets or results.
 */

export const RESULT_USAGE_HEADLINE = "이 스레드 · 이 서버가 기록한 값";
export const RESULT_USAGE_SCOPE_NOTE = "사용량 화면의 제공자 계정 사용량과 범위가 다릅니다.";
export const RESULT_USAGE_SNAPSHOT_NOTE = "이 패널을 열어 읽은 시점까지의 기록 기준입니다.";

/** Fixed copy for every non-row disclosure state; never zero as a stand-in. */
export const RESULT_USAGE_STATE_COPY: Record<
  Exclude<ResultUsageDisclosureState["phase"], "row" | "hidden">,
  string
> = {
  loading: "사용량 기록을 읽는 중…",
  unsupported: "이 서버 버전은 결과별 사용량 읽기를 지원하지 않습니다.",
  "read-failed": "사용량 기록을 읽을 수 없습니다.",
  "row-missing": "이 기록의 사용량을 가져올 수 없습니다. 새로고침해 주세요.",
  "missing-create": "스레드 생성 기록을 찾을 수 없어 사용량을 읽을 수 없습니다.",
  "too-large": "스레드 기록이 너무 커서 사용량을 읽을 수 없습니다.",
};

const UNMEASURABLE_COPY: Record<OwnedResultUnmeasurableReason, string> = {
  "activity-during-attempt": "이 시도 동안 다른 활동이 있어 사용량을 나눌 수 없습니다.",
  "turn-active-at-attempt":
    "이 시도가 시작될 때 다른 작업이 진행 중이라 사용량을 나눌 수 없습니다.",
  "revision-conflict": "같은 기록의 서로 다른 내용이 남아 있어 사용량을 확정할 수 없습니다.",
  "invalid-receipt-or-window":
    "기록이 손상되었거나 구간을 확정할 수 없어 사용량을 나눌 수 없습니다.",
  "unresolved-ownership-or-history":
    "실행 주체나 이력을 확정할 수 없어 사용량을 확정할 수 없습니다.",
};

/** Days/hours/minutes/seconds from a nonnegative millisecond value. */
function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  if (minutes > 0) return `${minutes}분 ${seconds}초`;
  return `${seconds}초`;
}

/**
 * Cache dimensions report "k of n turns reported"; zero reporting turns means
 * the dimension was never reported, which is not zero usage. An explicit 0
 * sum with reporting turns counts as reported.
 */
function formatCachePart(
  label: string,
  cache: { readonly sum: number; readonly reportedTurns: number },
  completeTurns: number,
): string {
  if (cache.reportedTurns === 0) return `${label} 미보고`;
  return `${label} ${cache.sum}(${cache.reportedTurns}/${completeTurns}턴 보고)`;
}

export function formatResultUsageBucketLine(bucket: OwnedMainUsageBucketV1): string {
  const scope = bucket.scope;
  const subtotal = bucket.reportedCompleteSubtotal;
  const conversation =
    scope.nativeConversationId === null ? "대화 미확인" : `대화 ${scope.nativeConversationId}`;
  return [
    `${scope.driver} · ${scope.instanceId} · ${conversation}`,
    `입력 ${subtotal.inputTokens}`,
    `출력 ${subtotal.outputTokens}`,
    formatCachePart("캐시 입력", subtotal.cachedInputTokens, subtotal.completeTurns),
    formatCachePart("캐시 생성", subtotal.cacheCreationTokens, subtotal.completeTurns),
    formatCachePart("추론", subtotal.reasoningTokens, subtotal.completeTurns),
    `완전 턴 ${subtotal.completeTurns}`,
  ].join(" · ");
}

function formatCoverageCounts(coverage: OwnedResultCoverageV1): string {
  return [
    `완전 ${coverage.complete}`,
    `부분 ${coverage.partial}`,
    `불가 ${coverage.unavailable}`,
    `모호 ${coverage.ambiguous}`,
    `오염 ${coverage.conflictTainted}`,
    `범위 밖 ${coverage.unscoped}`,
    `미기록 ${coverage.unrecorded}`,
    `늦은 관측(제외) ${coverage.lateUnattributed}`,
  ].join(" · ");
}

export function formatResultUsageCoverageLine(coverage: OwnedResultCoverageV1): string {
  return `턴 범위 · ${formatCoverageCounts(coverage)}`;
}

/** Counts only, shown when anything after the last result was observed. */
export function formatResultUsageTrailingLine(trailing: OwnedResultUsageTrailingV1): string | null {
  const coverage = trailing.coverage;
  const hasCoverage =
    coverage.complete > 0 ||
    coverage.partial > 0 ||
    coverage.unavailable > 0 ||
    coverage.ambiguous > 0 ||
    coverage.conflictTainted > 0 ||
    coverage.unscoped > 0 ||
    coverage.unrecorded > 0 ||
    coverage.lateUnattributed > 0;
  if (trailing.inputs === 0 && trailing.otherAttempts === 0 && !hasCoverage) return null;
  return `마지막 결과 이후 · 입력 ${trailing.inputs}회 · 다른 시도 ${trailing.otherAttempts}회 · ${formatCoverageCounts(coverage)}`;
}

/**
 * All lines for one exact result row. `checksMs` covers only the recorded
 * runner interval; `recordedSpanMs` is the difference of recorded event
 * timestamps and is labeled as such — null stays "측정 없음", never zero.
 */
export function formatResultUsageRowLines(row: OwnedResultUsageV1): ReadonlyArray<string> {
  const lines: string[] = [
    `입력 ${row.inputs}회 · 다른 시도 ${row.otherAttempts}회`,
    row.checksMs === null
      ? "검사 실행 시간: 측정 없음"
      : `검사 실행 시간: ${formatDurationMs(row.checksMs)}`,
    row.recordedSpan.recordedSpanMs === null
      ? "기록 시각 차이: 측정 없음"
      : `기록 시각 차이: ${formatDurationMs(row.recordedSpan.recordedSpanMs)}(기록된 시각의 차이이며 실제 실행 시간이 아님)`,
  ];
  if (row.usage.status === "measured") {
    lines.push(formatResultUsageCoverageLine(row.usage.coverage));
    for (const bucket of row.usage.buckets) lines.push(formatResultUsageBucketLine(bucket));
    lines.push(
      `하위 작업 ${row.usage.childFrames} frame · 미포함(중복 여부 불명)` +
        (row.usage.legacyChildFrames > 0
          ? ` · 이전 방식 ${row.usage.legacyChildFrames} frame`
          : ""),
    );
    lines.push("비용: 알 수 없음(청구액 기록 없음)");
  } else {
    lines.push(`사용량 확정 불가 · ${UNMEASURABLE_COPY[row.usage.reason]}`);
  }
  return lines;
}
