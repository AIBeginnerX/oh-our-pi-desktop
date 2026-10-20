import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PROJECT_SKILL_LIMITS, type ProjectSkillCandidateSourceIdentity } from "./projectSkill.ts";

const SECTION_HEADING_RE = /^\s*(?:#{1,6}\s+)?(procedure|steps)\b\s*:?\s*$/i;
const MARKDOWN_HEADING_RE = /^\s*#{1,6}\s+\S/;
const STEP_LINE_RE = /^\s*(?:\d+[.)]\s+|[-*]\s+)\S/;

const DraftContentField = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const ProjectSkillReviewDraftUnavailableReason = Schema.Literals([
  "no-coherent-source",
  "no-procedure-section",
  "procedure-empty",
  "procedure-ambiguous",
]);
export type ProjectSkillReviewDraftUnavailableReason =
  typeof ProjectSkillReviewDraftUnavailableReason.Type;

/** Per-field truncation flags; absent means the field fit within its limit. */
export const ProjectSkillReviewDraftTruncation = Schema.Struct({
  title: Schema.optionalKey(Schema.Literal(true)),
  purpose: Schema.optionalKey(Schema.Literal(true)),
  appliesWhen: Schema.optionalKey(Schema.Literal(true)),
  procedure: Schema.optionalKey(Schema.Literal(true)),
  successCheck: Schema.optionalKey(Schema.Literal(true)),
});
export type ProjectSkillReviewDraftTruncation = typeof ProjectSkillReviewDraftTruncation.Type;

/**
 * Partial review-draft content the derive path may seed. Exclusions stay
 * absent — never fabricated — and `doesNotApplyWhen` is intentionally omitted
 * until the user fills it at save.
 */
export const ProjectSkillReviewDraftPartial = Schema.Struct({
  title: DraftContentField(PROJECT_SKILL_LIMITS.title),
  purpose: DraftContentField(PROJECT_SKILL_LIMITS.purpose),
  appliesWhen: DraftContentField(PROJECT_SKILL_LIMITS.appliesWhen),
  procedure: DraftContentField(PROJECT_SKILL_LIMITS.procedure),
  successCheck: DraftContentField(PROJECT_SKILL_LIMITS.successCheck),
});
export type ProjectSkillReviewDraftPartial = typeof ProjectSkillReviewDraftPartial.Type;

const boundField = (
  value: string,
  max: number,
): { readonly text: string; readonly truncated: boolean } => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { text: "", truncated: false };
  }
  if (trimmed.length <= max) {
    return { text: trimmed, truncated: false };
  }
  return { text: trimmed.slice(0, max), truncated: true };
};

export type ExtractProjectSkillProcedureSectionResult =
  | { readonly outcome: "ok"; readonly text: string }
  | {
      readonly outcome: "unavailable";
      readonly reason: Exclude<ProjectSkillReviewDraftUnavailableReason, "no-coherent-source">;
    };

/**
 * Extract one Procedure/Steps section. Requires at least one numbered or
 * bulleted step, then returns the full section body (including continuations
 * and code under steps) until the next heading.
 */
export function extractProjectSkillProcedureSection(
  assistantMessageBody: string,
): ExtractProjectSkillProcedureSectionResult {
  const lines = assistantMessageBody.split(/\r?\n/);
  const sectionStarts: Array<number> = [];
  for (let index = 0; index < lines.length; index++) {
    if (SECTION_HEADING_RE.test(lines[index] ?? "")) {
      sectionStarts.push(index);
    }
  }
  if (sectionStarts.length === 0) {
    return { outcome: "unavailable", reason: "no-procedure-section" };
  }
  if (sectionStarts.length > 1) {
    return { outcome: "unavailable", reason: "procedure-ambiguous" };
  }
  const startIndex = sectionStarts[0]! + 1;
  const sectionLines: Array<string> = [];
  for (let index = startIndex; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (MARKDOWN_HEADING_RE.test(line)) {
      break;
    }
    if (/^\s*(?:summary|done|result|notes)\b\s*:?\s*$/i.test(line)) {
      break;
    }
    sectionLines.push(line);
  }
  const hasStep = sectionLines.some((line) => STEP_LINE_RE.test(line));
  if (!hasStep) {
    const nonempty = sectionLines.some((line) => line.trim().length > 0);
    return nonempty
      ? { outcome: "unavailable", reason: "procedure-empty" }
      : { outcome: "unavailable", reason: "no-procedure-section" };
  }
  const text = sectionLines.join("\n").trim();
  if (text.length === 0) {
    return { outcome: "unavailable", reason: "procedure-empty" };
  }
  return { outcome: "ok", text };
}

export type DeriveSkillReviewDraftInput = {
  readonly sourceIdentity: ProjectSkillCandidateSourceIdentity;
  readonly threadTitle: string;
  readonly userRequest: string;
  readonly boundRequirementText: string;
  readonly boundSuccessCheckText: string;
  readonly assistantMessageBody: string;
};

export type DeriveSkillReviewDraftResult =
  | {
      readonly outcome: "available";
      readonly partial: ProjectSkillReviewDraftPartial;
      readonly truncation: ProjectSkillReviewDraftTruncation;
      readonly sourceIdentity: ProjectSkillCandidateSourceIdentity;
    }
  | {
      readonly outcome: "unavailable";
      readonly reason: ProjectSkillReviewDraftUnavailableReason;
    };

/**
 * Build a bounded partial review draft from explicit immutable inputs. Does
 * not read storage, choose messages, or claim a generalizable procedure.
 */
export function deriveSkillReviewDraft(
  input: DeriveSkillReviewDraftInput,
): DeriveSkillReviewDraftResult {
  const extracted = extractProjectSkillProcedureSection(input.assistantMessageBody);
  if (extracted.outcome === "unavailable") {
    return { outcome: "unavailable", reason: extracted.reason };
  }

  const title = boundField(input.threadTitle, PROJECT_SKILL_LIMITS.title);
  const purpose = boundField(input.userRequest, PROJECT_SKILL_LIMITS.purpose);
  const appliesWhen = boundField(input.boundRequirementText, PROJECT_SKILL_LIMITS.appliesWhen);
  const procedure = boundField(extracted.text, PROJECT_SKILL_LIMITS.procedure);
  const successCheck = boundField(input.boundSuccessCheckText, PROJECT_SKILL_LIMITS.successCheck);

  if (
    title.text.length === 0 ||
    purpose.text.length === 0 ||
    appliesWhen.text.length === 0 ||
    procedure.text.length === 0 ||
    successCheck.text.length === 0
  ) {
    return { outcome: "unavailable", reason: "no-coherent-source" };
  }

  const truncation: ProjectSkillReviewDraftTruncation = {
    ...(title.truncated ? { title: true } : {}),
    ...(purpose.truncated ? { purpose: true } : {}),
    ...(appliesWhen.truncated ? { appliesWhen: true } : {}),
    ...(procedure.truncated ? { procedure: true } : {}),
    ...(successCheck.truncated ? { successCheck: true } : {}),
  };

  return {
    outcome: "available",
    partial: {
      title: title.text,
      purpose: purpose.text,
      appliesWhen: appliesWhen.text,
      procedure: procedure.text,
      successCheck: successCheck.text,
    },
    truncation,
    sourceIdentity: input.sourceIdentity,
  };
}
