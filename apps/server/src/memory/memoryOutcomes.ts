import { FAILURE_SIGNAL_KINDS, type WorkSignal, type WorkSignalKind } from "./workDigest.ts";

const GOOD_SIGNAL_KINDS: ReadonlySet<WorkSignalKind> = new Set([
  "check-passed",
  "check-failed-then-passed",
  "result-accepted",
  "audit-approved",
  "audit-needs-changes-then-fixed",
  "crew-work-verified",
]);

export function judgeMemoryOutcome(
  signals: ReadonlyArray<WorkSignal>,
  sentAfterSequence: number,
): "good" | "bad" | "unknown" {
  let good = false;
  for (const { kind, eventSeq } of signals) {
    if (eventSeq <= sentAfterSequence) continue;
    if (FAILURE_SIGNAL_KINDS.has(kind) || kind === "revert" || kind === "result-withdrawn") {
      return "bad";
    }
    if (GOOD_SIGNAL_KINDS.has(kind)) good = true;
  }
  return good ? "good" : "unknown";
}
