import {
  OWNED_USAGE_ACTIVITY_KIND,
  SELECTED_CHECK_RECEIPT_KIND,
  TASK_RESULT_ACTIVITY_KIND,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { isCrewFollowUp } from "../crew/crewLogic.ts";

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
  | "check-passed"
  | "check-failed"
  | "check-failed-then-passed"
  | "result-accepted"
  | "audit-approved"
  | "audit-needs-changes-then-fixed"
  | "audit-needs-changes-unresolved"
  | "crew-work-verified"
  | "crew-work-unverified"
  | "revert"
  | "interrupt-then-follow-up"
  | "result-withdrawn";

/**
 * Signals for work that did not succeed. The model reads them to see what goes
 * wrong; a suggestion still needs threads with other signals to be filed.
 */
export const FAILURE_SIGNAL_KINDS: ReadonlySet<WorkSignalKind> = new Set([
  "check-failed",
  "audit-needs-changes-unresolved",
  "crew-work-unverified",
]);

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

const decodeCrewCompletion = Schema.decodeUnknownOption(
  Schema.Struct({
    crewRole: Schema.Literals(["worker", "expert"]),
    taskId: Schema.optional(Schema.String),
    status: Schema.Literals(["completed", "failed"]),
    proof: Schema.optional(Schema.String),
  }),
);

type Attempt = {
  readonly revision: number;
  readonly sequence: number;
  readonly receipt: typeof ReceiptView.Type;
};

const FAILED_STATUSES = new Set(["failed", "timed-out"]);

export type WorkDigestEvent<Event = OrchestrationEvent> = Event extends OrchestrationEvent
  ? Pick<Event, "aggregateKind" | "aggregateId" | "type" | "sequence"> &
      (Event extends Extract<OrchestrationEvent, { type: "thread.message-sent" }>
        ? { readonly payload: Pick<Event["payload"], "role" | "streaming" | "text"> }
        : Event extends Extract<
              OrchestrationEvent,
              { type: "thread.activity-appended" | "thread.turn-diff-completed" }
            >
          ? Pick<Event, "payload">
          : object)
  : never;

/**
 * Digest of one thread's events. Events of other aggregates are ignored and
 * input order does not matter. Only the thread's latest incarnation counts: a
 * deleted-and-recreated thread starts over at its newest `thread.created`.
 */
export function deriveWorkDigest(
  threadId: ThreadId,
  events: ReadonlyArray<WorkDigestEvent>,
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
  const unverifiedCrew = new Map<string | undefined, WorkSignal>();
  const verifiedCrew = new Set<string | undefined>();
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
        if (event.payload.role !== "user" || event.payload.streaming) break;
        // A user message after an interrupt is the user steering the work.
        if (interruptPending) {
          interruptPending = false;
          signals.push({ kind: "interrupt-then-follow-up", eventSeq: event.sequence });
        }
        // Requested changes belong to the request they reviewed. Crew follow-ups
        // continue that request; a new one means a later approval is no fix.
        if (!isCrewFollowUp(event.payload.text)) needsChangesPending = false;
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
          if (acceptedNow && !result.acceptedNow) {
            result.accepted += 1;
            signals.push({ kind: "result-accepted", eventSeq: event.sequence });
          }
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
          const completion = decodeCrewCompletion(activity.payload);
          if (Option.isSome(completion)) {
            const { status, proof, taskId } = completion.value;
            if (status === "completed" && proof === "verified") {
              signals.push({ kind: "crew-work-verified", eventSeq: event.sequence });
              verifiedCrew.add(taskId);
              unverifiedCrew.delete(taskId);
            } else if (!verifiedCrew.has(taskId) && !unverifiedCrew.has(taskId)) {
              unverifiedCrew.set(taskId, {
                kind: "crew-work-unverified",
                eventSeq: event.sequence,
              });
            }
            break;
          }
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
          else if (verdict === "approve") {
            signals.push({
              kind: needsChangesPending ? "audit-needs-changes-then-fixed" : "audit-approved",
              eventSeq: event.sequence,
            });
            needsChangesPending = false;
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const lastVerdict = audits.findLast((audit) => audit.verdict !== null);
  if (lastVerdict?.verdict === "needs-changes") {
    signals.push({ kind: "audit-needs-changes-unresolved", eventSeq: lastVerdict.eventSeq });
  }
  for (const signal of unverifiedCrew.values()) signals.push(signal);
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
 * signal for a clean pass, a recovery or an unrecovered failure. A newer
 * attempt without an outcome for that check leaves the failure unsettled.
 */
function summariseChecks(
  attempts: ReadonlyArray<Attempt>,
  signals: Array<WorkSignal>,
): ReadonlyArray<WorkDigestCheck> {
  const timelines = new Map<
    string,
    { name: string; outcomes: Array<{ ok: boolean; sequence: number }> }
  >();
  const latestAttempts = new Map<string, number>();
  for (const attempt of attempts.toSorted((left, right) => left.sequence - right.sequence)) {
    const names = new Map(attempt.receipt.planned.map((p) => [p.scriptId, p.scriptName]));
    for (const scriptId of names.keys()) latestAttempts.set(scriptId, attempt.sequence);
    if (attempt.receipt.phase === "running") continue;
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
  for (const [scriptId, timeline] of timelines) {
    const failedAt = timeline.outcomes.findIndex((outcome) => !outcome.ok);
    const fixed = failedAt === -1 ? undefined : timeline.outcomes.slice(failedAt).find((o) => o.ok);
    const passing = failedAt === -1 ? timeline.outcomes.at(-1) : fixed;
    const last = timeline.outcomes.at(-1);
    const passed = timeline.outcomes.filter((outcome) => outcome.ok).length;
    if (passing !== undefined) {
      signals.push({
        kind: fixed === undefined ? "check-passed" : "check-failed-then-passed",
        eventSeq: passing.sequence,
        subject: timeline.name,
      });
    } else if (
      passed === 0 &&
      last !== undefined &&
      latestAttempts.get(scriptId) === last.sequence
    ) {
      signals.push({ kind: "check-failed", eventSeq: last.sequence, subject: timeline.name });
    }
    summary.push({
      name: timeline.name,
      passed,
      failed: timeline.outcomes.length - passed,
      lastStatus: last?.ok === true ? "passed" : "failed",
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
