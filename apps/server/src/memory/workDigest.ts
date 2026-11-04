import {
  OWNED_USAGE_ACTIVITY_KIND,
  SELECTED_CHECK_RECEIPT_KIND,
  TASK_RESULT_ACTIVITY_KIND,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The work digest: a compact, structured account of what happened in one
 * thread, derived from its raw orchestration events.
 *
 * Raw events, not the read model: the projection keeps only the newest 500
 * activities per thread, so a long thread would be summarised from its tail.
 * The digest is a pure function of the events it is given, so replaying the
 * same events gives the same digest and nothing needs to be stored besides
 * the analysis cursor. Every fact carries the event sequence it came from,
 * which is what a lesson later cites as evidence.
 *
 * It holds structured facts only: check names and outcomes, counts, verdicts,
 * file paths, token totals. No user or assistant message text is read. The
 * single provider-written string is an auditor's excerpt; `withoutProviderText`
 * drops it for threads whose provider text must not leave the server.
 */

export const WORK_DIGEST_MAX_FILES = 30;
export const WORK_DIGEST_MAX_CHECKS = 10;
export const WORK_DIGEST_MAX_AUDITS = 5;
export const WORK_DIGEST_MAX_SIGNALS = 20;
const AUDIT_SUMMARY_MAX_CHARS = 400;

export type WorkSignalKind =
  | "check-failed-then-passed"
  | "audit-needs-changes-then-fixed"
  | "revert"
  | "interrupt-then-follow-up"
  | "result-withdrawn";

/** A structural fact worth learning from, with the event that proves it. */
export interface WorkSignal {
  readonly kind: WorkSignalKind;
  readonly eventSeq: number;
  /** The check name for check signals; absent otherwise. */
  readonly subject?: string;
}

export interface WorkDigestCheck {
  readonly name: string;
  readonly passed: number;
  readonly failed: number;
  readonly lastStatus: "passed" | "failed";
}

export interface WorkDigestAudit {
  readonly eventSeq: number;
  readonly verdict: "approve" | "needs-changes" | null;
  /**
   * The auditor's own (crew child) thread, where its words were produced. The
   * lead only records the completion, so the lead's echo state says nothing
   * about this text. Null when the event does not name it.
   */
  readonly sourceThreadId: ThreadId | null;
  /** Provider-written excerpt; null once `withoutProviderText` has run. */
  readonly summary: string | null;
}

export interface ThreadWorkDigest {
  readonly threadId: ThreadId;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly checks: ReadonlyArray<WorkDigestCheck>;
  readonly result: {
    readonly accepted: number;
    readonly withdrawn: number;
    readonly acceptedNow: boolean;
  };
  readonly audits: ReadonlyArray<WorkDigestAudit>;
  readonly reverts: number;
  readonly interrupts: number;
  readonly changedFiles: ReadonlyArray<string>;
  readonly usage: {
    readonly turns: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
  };
  readonly signals: ReadonlyArray<WorkSignal>;
}

const ReceiptView = Schema.Struct({
  attemptId: Schema.String,
  revision: Schema.Number,
  phase: Schema.String,
  planned: Schema.Array(Schema.Struct({ scriptId: Schema.String, scriptName: Schema.String })),
  checks: Schema.Array(Schema.Struct({ scriptId: Schema.String, status: Schema.String })),
});
const decodeReceipt = Schema.decodeUnknownOption(ReceiptView);

const TaskResultView = Schema.Struct({
  requirements: Schema.NullOr(Schema.Struct({ version: Schema.Number })),
  acceptance: Schema.NullOr(Schema.Struct({ acceptedAt: Schema.String })),
});
const decodeTaskResult = Schema.decodeUnknownOption(TaskResultView);

const UsageView = Schema.Struct({
  usage: Schema.Struct({
    inputTokens: Schema.optional(Schema.Number),
    outputTokens: Schema.optional(Schema.Number),
  }),
  costUsd: Schema.optional(Schema.Number),
});
const decodeUsage = Schema.decodeUnknownOption(UsageView);

const AuditView = Schema.Struct({
  crewRole: Schema.Literal("auditor"),
  threadId: Schema.optional(Schema.String),
  verdict: Schema.optional(Schema.NullOr(Schema.Literals(["approve", "needs-changes"]))),
  summary: Schema.optional(Schema.String),
});
const decodeAudit = Schema.decodeUnknownOption(AuditView);

type Attempt = {
  readonly revision: number;
  readonly sequence: number;
  readonly receipt: typeof ReceiptView.Type;
};

const FAILED_STATUSES = new Set(["failed", "timed-out"]);

/**
 * Digest of one thread's events. Events of other aggregates are ignored and
 * input order does not matter. Only the thread's latest incarnation counts: a
 * deleted-and-recreated thread starts over at its newest `thread.created`.
 */
export function deriveWorkDigest(
  threadId: ThreadId,
  events: ReadonlyArray<OrchestrationEvent>,
): ThreadWorkDigest {
  const own = events
    .filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId)
    .toSorted((left, right) => left.sequence - right.sequence);
  const createdAt = own.findLastIndex((event) => event.type === "thread.created");
  const history = createdAt === -1 ? own : own.slice(createdAt);

  const attempts = new Map<string, Attempt>();
  const files = new Set<string>();
  const audits: Array<WorkDigestAudit> = [];
  const signals: Array<WorkSignal> = [];
  const usageIds = new Set<string>();
  const usage = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  const result = { accepted: 0, withdrawn: 0, acceptedNow: false };
  let requirementsVersion: number | null = null;
  let reverts = 0;
  let interrupts = 0;
  let interruptPending = false;
  let needsChangesPending = false;

  for (const event of history) {
    switch (event.type) {
      case "thread.reverted": {
        reverts += 1;
        signals.push({ kind: "revert", eventSeq: event.sequence });
        break;
      }
      case "thread.turn-interrupt-requested": {
        interrupts += 1;
        interruptPending = true;
        break;
      }
      case "thread.message-sent": {
        // A user message after an interrupt is the user steering the work.
        if (interruptPending && event.payload.role === "user" && !event.payload.streaming) {
          interruptPending = false;
          signals.push({ kind: "interrupt-then-follow-up", eventSeq: event.sequence });
        }
        break;
      }
      case "thread.turn-diff-completed": {
        for (const file of event.payload.files) files.add(file.path);
        break;
      }
      case "thread.activity-appended": {
        const { activity } = event.payload;
        if (activity.kind === SELECTED_CHECK_RECEIPT_KIND) {
          const receipt = decodeReceipt(activity.payload);
          if (Option.isNone(receipt)) break;
          const known = attempts.get(receipt.value.attemptId);
          if (known === undefined || receipt.value.revision >= known.revision) {
            attempts.set(receipt.value.attemptId, {
              revision: receipt.value.revision,
              sequence: event.sequence,
              receipt: receipt.value,
            });
          }
        } else if (activity.kind === TASK_RESULT_ACTIVITY_KIND) {
          const record = decodeTaskResult(activity.payload);
          if (Option.isNone(record)) break;
          const version = record.value.requirements?.version ?? null;
          const acceptedNow = record.value.acceptance !== null;
          if (acceptedNow && !result.acceptedNow) result.accepted += 1;
          // Editing the requirements also clears an acceptance; that is a new
          // spec, not the user turning the result down.
          if (!acceptedNow && result.acceptedNow && version === requirementsVersion) {
            result.withdrawn += 1;
            signals.push({ kind: "result-withdrawn", eventSeq: event.sequence });
          }
          result.acceptedNow = acceptedNow;
          requirementsVersion = version;
        } else if (activity.kind === OWNED_USAGE_ACTIVITY_KIND) {
          if (usageIds.has(activity.id)) break;
          usageIds.add(activity.id);
          const observed = decodeUsage(activity.payload);
          if (Option.isNone(observed)) break;
          usage.turns += 1;
          usage.inputTokens += observed.value.usage.inputTokens ?? 0;
          usage.outputTokens += observed.value.usage.outputTokens ?? 0;
          usage.costUsd += observed.value.costUsd ?? 0;
        } else if (activity.kind === "task.completed") {
          const audit = decodeAudit(activity.payload);
          if (Option.isNone(audit)) break;
          const verdict = audit.value.verdict ?? null;
          audits.push({
            eventSeq: event.sequence,
            verdict,
            sourceThreadId:
              audit.value.threadId === undefined ? null : ThreadId.make(audit.value.threadId),
            summary: boundedExcerpt(audit.value.summary),
          });
          if (verdict === "needs-changes") needsChangesPending = true;
          else if (verdict === "approve" && needsChangesPending) {
            needsChangesPending = false;
            signals.push({ kind: "audit-needs-changes-then-fixed", eventSeq: event.sequence });
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const checks = summariseChecks([...attempts.values()], signals);
  const orderedSignals = signals
    .toSorted((left, right) => left.eventSeq - right.eventSeq)
    .slice(-WORK_DIGEST_MAX_SIGNALS);

  return {
    threadId,
    firstSequence: history[0]?.sequence ?? 0,
    lastSequence: history.at(-1)?.sequence ?? 0,
    checks,
    result,
    audits: audits.slice(-WORK_DIGEST_MAX_AUDITS),
    reverts,
    interrupts,
    changedFiles: [...files].toSorted().slice(0, WORK_DIGEST_MAX_FILES),
    usage,
    signals: orderedSignals,
  };
}

/**
 * Per check: how often it passed and failed across finished attempts, and a
 * signal when a failure was followed by a pass. An attempt still `running`
 * has no outcome yet and is skipped.
 */
function summariseChecks(
  attempts: ReadonlyArray<Attempt>,
  signals: Array<WorkSignal>,
): ReadonlyArray<WorkDigestCheck> {
  const timelines = new Map<
    string,
    { name: string; outcomes: Array<{ ok: boolean; sequence: number }> }
  >();
  for (const attempt of attempts.toSorted((left, right) => left.sequence - right.sequence)) {
    if (attempt.receipt.phase === "running") continue;
    const names = new Map(attempt.receipt.planned.map((p) => [p.scriptId, p.scriptName]));
    for (const check of attempt.receipt.checks) {
      const ok = check.status === "passed";
      if (!ok && !FAILED_STATUSES.has(check.status)) continue;
      const timeline = timelines.get(check.scriptId) ?? {
        name: names.get(check.scriptId) ?? check.scriptId,
        outcomes: [],
      };
      timeline.outcomes.push({ ok, sequence: attempt.sequence });
      timelines.set(check.scriptId, timeline);
    }
  }
  const summary: Array<WorkDigestCheck> = [];
  for (const timeline of timelines.values()) {
    const failedAt = timeline.outcomes.findIndex((outcome) => !outcome.ok);
    const fixed = failedAt === -1 ? undefined : timeline.outcomes.slice(failedAt).find((o) => o.ok);
    if (fixed !== undefined) {
      signals.push({
        kind: "check-failed-then-passed",
        eventSeq: fixed.sequence,
        subject: timeline.name,
      });
    }
    summary.push({
      name: timeline.name,
      passed: timeline.outcomes.filter((outcome) => outcome.ok).length,
      failed: timeline.outcomes.filter((outcome) => !outcome.ok).length,
      lastStatus: timeline.outcomes.at(-1)?.ok === true ? "passed" : "failed",
    });
  }
  return summary.toSorted((a, b) => a.name.localeCompare(b.name)).slice(0, WORK_DIGEST_MAX_CHECKS);
}

function boundedExcerpt(text: string | undefined): string | null {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return null;
  return trimmed.length > AUDIT_SUMMARY_MAX_CHARS
    ? `${trimmed.slice(0, AUDIT_SUMMARY_MAX_CHARS - 1)}…`
    : trimmed;
}

/** The digest minus every provider-written string. Used for echo-tainted threads. */
export function withoutProviderText(digest: ThreadWorkDigest): ThreadWorkDigest {
  return { ...digest, audits: digest.audits.map((audit) => ({ ...audit, summary: null })) };
}

/**
 * The digest minus the excerpts of auditors whose own thread is not known to
 * be clean. An excerpt with no named source thread cannot be vouched for and
 * is dropped too.
 */
export function withoutUnverifiedAuditText(
  digest: ThreadWorkDigest,
  cleanSourceThreads: ReadonlySet<ThreadId>,
): ThreadWorkDigest {
  return {
    ...digest,
    audits: digest.audits.map((audit) =>
      audit.sourceThreadId !== null && cleanSourceThreads.has(audit.sourceThreadId)
        ? audit
        : { ...audit, summary: null },
    ),
  };
}
