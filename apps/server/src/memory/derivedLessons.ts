import {
  PROJECT_MEMORY_EVIDENCE_MIN_THREADS,
  PROJECT_MEMORY_ANALYSER_RUN_MAX,
  type ProjectMemoryEvidence,
  type ThreadId,
} from "@t3tools/contracts";

import type { WorkLessonsGenerationResult } from "../textGeneration/TextGeneration.ts";
import { looksLikeSensitiveText } from "./sensitiveText.ts";
import { FAILURE_SIGNAL_KINDS, type ThreadWorkDigest, type WorkSignal } from "./workDigest.ts";

/**
 * Pure pieces of the work analyser: what the model is shown, and how its
 * answer is checked before anything becomes a pending suggestion.
 */

/** Token overlap at or above which a text is the same lesson as another. */
export const LESSON_DUPLICATE_SIMILARITY = 0.8;
/** Token overlap at or above which an existing memory is shown beside a suggestion. */
export const LESSON_RELATED_SIMILARITY = 0.3;

/** Case-, width- and whitespace-insensitive form used for hashing and comparison. */
export const normalizeLessonText = (text: string): string =>
  text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

const tokens = (text: string): ReadonlySet<string> =>
  new Set(normalizeLessonText(text).match(/[\p{L}\p{N}]+/gu) ?? []);

/** Jaccard overlap of the word sets of two texts, 0 to 1. */
export function lessonSimilarity(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * The digests the model is shown: safe ones with signals, and only when at
 * least two distinct threads have them, since no lesson could be backed with fewer.
 */
export function selectDigestInputs(digests: ReadonlyArray<ThreadWorkDigest>) {
  const signalled = digests.filter((digest) => digest.signals.length > 0);
  // Usage is numeric metadata. Long inputTokens/outputTokens counts can look
  // like credential assignments when scanned with their JSON keys.
  const eligible = signalled.filter(
    (digest) => !looksLikeSensitiveText(JSON.stringify({ ...digest, usage: undefined })),
  );
  return {
    digestsWithSignals: signalled.length,
    sensitiveFiltered: signalled.length - eligible.length,
    eligible: eligible.length,
    promptDigests: eligible.length >= PROJECT_MEMORY_EVIDENCE_MIN_THREADS ? eligible : [],
  };
}

/**
 * The text the model sees, labelled T1, T2, … in the given order. Structured
 * fields only: no thread ids, event numbers or message text. An auditor's
 * excerpt appears only when the digest still carries one.
 */
export function buildDigestPromptInput(digests: ReadonlyArray<ThreadWorkDigest>): string {
  return JSON.stringify(
    digests.map((digest, index) => ({
      label: `T${index + 1}`,
      checks: digest.checks,
      result: digest.result,
      audits: digest.audits.map((audit) => ({
        verdict: audit.verdict,
        ...(audit.summary === null ? {} : { summary: audit.summary }),
      })),
      reverts: digest.reverts,
      interrupts: digest.interrupts,
      changedFiles: digest.changedFiles,
      usage: digest.usage,
      signals: digest.signals.map(({ kind, subject }) => ({
        kind,
        ...(subject === undefined ? {} : { subject }),
      })),
    })),
  );
}

/** An accepted result whose last run of every check passed: a sound skill-draft source. */
export const isSkillSource = (digest: ThreadWorkDigest): boolean =>
  digest.result.acceptedNow &&
  digest.checks.length > 0 &&
  digest.checks.every((check) => check.lastStatus === "passed");

export interface LessonCandidate {
  readonly target: "memory" | "skill";
  readonly text: string;
  readonly evidence: ReadonlyArray<ProjectMemoryEvidence>;
  /** Every cited thread's evidence was matched by a check name the lesson mentions. */
  readonly evidenceNamed: boolean;
}

/** Signals cited per thread at most. */
const EVIDENCE_PER_THREAD_MAX = 3;

const isFailure = (signal: WorkSignal) => FAILURE_SIGNAL_KINDS.has(signal.kind);

/**
 * The thread's signals the lesson is about. Failures aside, those are the
 * signals whose check name the lesson mentions; a lesson that names no check
 * cannot be tied to one signal, so the thread's first stands for it. A failure
 * is added only when the lesson names its check, and a thread whose signals
 * are all failures does not back a lesson.
 */
const evidenceOf = (digest: ThreadWorkDigest, text: string) => {
  const lesson = normalizeLessonText(text);
  const mentioned = (signal: WorkSignal) =>
    signal.subject !== undefined && lesson.includes(normalizeLessonText(signal.subject));
  const backing = digest.signals.filter((signal) => !isFailure(signal));
  const named = backing.filter(mentioned);
  const failures = digest.signals.filter((signal) => isFailure(signal) && mentioned(signal));
  return {
    digest,
    backed: backing.length > 0,
    named: named.length > 0,
    evidence: [...(named.length > 0 ? named : backing.slice(0, 1)), ...failures]
      .slice(0, EVIDENCE_PER_THREAD_MAX)
      .map((signal): ProjectMemoryEvidence => ({
        threadId: digest.threadId,
        eventSeq: signal.eventSeq,
      })),
  };
};

/**
 * The model's lessons, kept only when the digests back them. Evidence is
 * chosen here from the digests, never taken from the model: it names the
 * labelled threads' own signal events. Each lesson needs at least two
 * distinct threads with a signal that is not a failure; a crew thread counts
 * on its own because its completion is read into its digest, not its lead's.
 * Procedures also need an accepted, passing source.
 */
export function selectLessons(
  output: WorkLessonsGenerationResult,
  digests: ReadonlyArray<ThreadWorkDigest>,
): ReadonlyArray<LessonCandidate> {
  const byLabel = new Map(digests.map((digest, index) => [`T${index + 1}`, digest]));
  const candidates: Array<LessonCandidate> = [];
  for (const lesson of output.lessons) {
    const text = lesson.text.normalize("NFC").trim();
    if (text === "" || looksLikeSensitiveText(text)) continue;
    const cited = new Map<ThreadId, ThreadWorkDigest>();
    for (const label of lesson.threads) {
      const digest = byLabel.get(label.trim());
      if (digest !== undefined && digest.signals.length > 0) cited.set(digest.threadId, digest);
    }
    const picks = [...cited.values()].map((digest) => evidenceOf(digest, text));
    const backed = picks.filter((pick) => pick.backed);
    if (backed.length < PROJECT_MEMORY_EVIDENCE_MIN_THREADS) continue;
    const procedure = lesson.category === "procedure";
    const source = procedure ? backed.find((pick) => isSkillSource(pick.digest)) : undefined;
    if (procedure && source === undefined) continue;
    const ordered = [
      ...(source === undefined ? [] : [source]),
      ...backed.filter((pick) => pick !== source),
      ...picks.filter((pick) => !pick.backed),
    ];
    candidates.push({
      target: procedure ? "skill" : "memory",
      text,
      evidence: ordered.flatMap((pick) => pick.evidence),
      evidenceNamed: backed.every((pick) => pick.named),
    });
  }
  return candidates.slice(0, PROJECT_MEMORY_ANALYSER_RUN_MAX);
}
