import {
  PROJECT_MEMORY_EVIDENCE_MIN_THREADS,
  PROJECT_MEMORY_ANALYSER_RUN_MAX,
  type ProjectMemoryEvidence,
  type ThreadId,
} from "@t3tools/contracts";

import type { WorkLessonsGenerationResult } from "../textGeneration/TextGeneration.ts";
import { looksLikeSensitiveText } from "./sensitiveText.ts";
import type { ThreadWorkDigest } from "./workDigest.ts";

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

/** A digest the analyser may look at: one that is sensitive-looking is left out whole. */
export const isAnalysable = (digest: ThreadWorkDigest): boolean =>
  digest.signals.length > 0 && !looksLikeSensitiveText(JSON.stringify(digest));

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

/**
 * The thread's signals the lesson is about: those whose check name the lesson
 * mentions. A lesson that names no check cannot be tied to one signal, so the
 * thread's first signal stands for it.
 */
const evidenceOf = (
  digest: ThreadWorkDigest,
  text: string,
): { readonly evidence: ReadonlyArray<ProjectMemoryEvidence>; readonly named: boolean } => {
  const lesson = normalizeLessonText(text);
  const named = digest.signals.filter(
    (signal) =>
      signal.subject !== undefined && lesson.includes(normalizeLessonText(signal.subject)),
  );
  const chosen = named.length > 0 ? named : digest.signals.slice(0, 1);
  return {
    named: named.length > 0,
    evidence: chosen
      .slice(0, EVIDENCE_PER_THREAD_MAX)
      .map((signal) => ({ threadId: digest.threadId, eventSeq: signal.eventSeq })),
  };
};

/**
 * The model's lessons, kept only when the digests back them. Evidence is
 * chosen here from the digests, never taken from the model: it names the
 * labelled threads' own signal events. A fact, prohibition or preference
 * needs at least two distinct cited pieces of work (a lead thread and its crew
 * helpers count once); a procedure is nominated as a
 * skill-draft source and needs a cited thread that is one. Anything else, or
 * sensitive-looking, is dropped. At most `PROJECT_MEMORY_ANALYSER_RUN_MAX`
 * remain.
 */
export function selectLessons(
  output: WorkLessonsGenerationResult,
  digests: ReadonlyArray<ThreadWorkDigest>,
  /** Lead thread of each crew child thread: a lead and its helpers are one piece of work. */
  leadOf: ReadonlyMap<ThreadId, ThreadId> = new Map(),
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
    if (lesson.category === "procedure") {
      const source = [...cited.values()].find(isSkillSource);
      if (source !== undefined) {
        const { evidence, named } = evidenceOf(source, text);
        candidates.push({ target: "skill", text, evidence, evidenceNamed: named });
      }
    } else if (
      new Set([...cited.keys()].map((threadId) => leadOf.get(threadId) ?? threadId)).size >=
      PROJECT_MEMORY_EVIDENCE_MIN_THREADS
    ) {
      const picks = [...cited.values()].map((digest) => evidenceOf(digest, text));
      candidates.push({
        target: "memory",
        text,
        evidence: picks.flatMap((pick) => pick.evidence),
        evidenceNamed: picks.every((pick) => pick.named),
      });
    }
  }
  return candidates.slice(0, PROJECT_MEMORY_ANALYSER_RUN_MAX);
}
