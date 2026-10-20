import {
  PROJECT_SKILL_LIMITS,
  SelectedChecksRunInput,
  type ProjectSkillCandidateSourceIdentity,
  type ProjectSkillContent,
  type ProjectSkillDeleteResult,
  type ProjectSkillDetail,
  type ProjectSkillEvidenceId,
  type ProjectSkillJudgment,
  type ProjectSkillReadinessGap,
  type ProjectSkillScreenReason,
  type ProjectSkillSource,
  type ProjectSkillSourceRejectReason,
  type ProjectSkillStoreRejectReason,
  type ProjectSkillTrialObservation,
  type ProjectSkillTrialProvisionalObservation,
  type ProjectSkillTrialSummary,
  type ProjectSkillVersionRef,
  type ProjectSkillVersionState,
  type ProjectSkillVersionView,
  type ProjectSkillWithdrawResult,
  type ProjectSkillReviewDraftPartial,
  type ProjectSkillReviewDraftTruncation,
  type ProjectSkillReviewDraftUnavailableReason,
  type RecordableProjectSkillJudgment,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { SelectedChecksView } from "@t3tools/client-runtime/state/selected-checks-control";

/**
 * Pure decisions for the project-skill candidates UI. Every rejection sentence
 * here is fixed local copy: server causes and submitted content are never
 * echoed back, and a resolved RPC is never treated as an applied mutation —
 * the result's own status union is.
 */

/** The receipt identity a candidate creation is pinned to. */
export interface SkillSourceTuple {
  readonly attemptId: string;
  readonly revision: number;
  readonly receiptSequence: number;
}

export interface SkillSourceCheckInput {
  readonly view: SelectedChecksView;
  readonly permission: "allowed" | "read-only" | "unknown";
  readonly manage: boolean;
}

/**
 * Whether the panel's current record may back a candidate creation, and the
 * exact tuple to freeze. This only decides the button and the local gate —
 * the server re-verifies the record at the write. Requires a settled,
 * error-free current get: the card's authority conditions plus no drift.
 */
export function skillSourceFromChecks(input: SkillSourceCheckInput): SkillSourceTuple | null {
  const { view, permission, manage } = input;
  if (!manage) return null;
  if (permission !== "allowed") return null;
  if (view.headline !== "passed") return null;
  if (view.recordAuthority !== "current") return null;
  const record = view.record;
  if (record === null || record.sequence === null) return null;
  if (view.getError !== null || view.getInFlight) return null;
  if (view.comparisonStale) return null;
  if (view.newerTurnAfterRecord) return null;
  if (view.changedScriptIds.length > 0) return null;
  if (view.commandInFlight !== null) return null;
  return {
    attemptId: record.receipt.attemptId,
    revision: record.receipt.revision,
    receiptSequence: record.sequence,
  };
}

export function sameSkillSource(a: SkillSourceTuple, b: SkillSourceTuple): boolean {
  return (
    a.attemptId === b.attemptId &&
    a.revision === b.revision &&
    a.receiptSequence === b.receiptSequence
  );
}

/** Full four-field version identity; judgments never move between versions. */
export function sameProjectSkillVersionRef(
  a: ProjectSkillVersionRef,
  b: ProjectSkillVersionRef,
): boolean {
  return (
    a.projectId === b.projectId &&
    a.skillId === b.skillId &&
    a.version === b.version &&
    a.contentSha256 === b.contentSha256
  );
}

/** The one prefilled field of a new candidate; the user writes the rest. */
export function successCheckPrefill(checkNames: ReadonlyArray<string>): string {
  const prefix = "Selected checks pass: ";
  const joined = checkNames.join(", ");
  const bound = PROJECT_SKILL_LIMITS.successCheck;
  if (prefix.length + joined.length <= bound) return prefix + joined;
  const suffix = "…";
  const allowed = Math.max(0, bound - prefix.length - suffix.length);
  return prefix + joined.slice(0, allowed) + suffix;
}

const STORE_REJECT_COPY: Record<ProjectSkillStoreRejectReason, string> = {
  screen: "The server screened this content and declined to save it.",
  "source-ineligible":
    "The passed record no longer qualifies. Run the checks again and save from the new record.",
  "source-changed": "New input was recorded after these checks. Run checks again.",
  "thread-missing": "The thread that produced this record no longer exists.",
  "project-missing": "The project no longer exists on this environment.",
  "draft-message-invalid": "The message cited as this draft's origin could not be used.",
  "judgment-kind-unavailable": "This judgment kind is not available for that version.",
  "ref-mismatch": "That version changed on the server. Review the refreshed version and try again.",
  "duplicate-content": "Same content as an existing version.",
  "not-ready":
    "이 버전은 아직 활성화할 준비가 되지 않았습니다. 아래 항목을 확인한 뒤 다시 시도해 주세요.",
  "state-changed": "프로젝트 스킬 상태가 서버에서 변경되었습니다. 다시 불러온 뒤 확인해 주세요.",
  "state-invalid": "이 버전 상태로는 요청할 수 없습니다. 화면을 갱신해 주세요.",
  "evidence-mismatch": "선택한 관측 기록이 더 이상 유효하지 않습니다. 다시 선택해 주세요.",
  "target-unconfirmed": "선택한 스레드·스크립트를 서버가 확인하지 못했습니다. 다시 선택해 주세요.",
};

export const READINESS_GAP_COPY: Record<ProjectSkillReadinessGap, string> = {
  state: "버전 상태가 활성화에 맞지 않습니다.",
  screen: "내용 검토에서 차단되었습니다.",
  "rights-unreviewed": "권리 판단이 필요합니다.",
  "review-missing": "검토 판단이 필요합니다.",
  "reproduction-missing": "재현 판단이 필요합니다.",
  "non-application-missing": "비적용 판단이 필요합니다.",
  "non-application-harmful": "해로운 비적용 사례를 해소해야 합니다.",
  "interference-missing": "간섭 판단이 필요합니다.",
  "interference-observed": "공존 간섭이 관측되었습니다.",
  "open-hold": "열린 보류가 있습니다.",
  "unsupported-provider": "지원되지 않는 제공자 환경입니다.",
  "environment-changed": "관측 환경이 현재와 일치하지 않습니다.",
};

const LIFECYCLE_REFETCH_REASONS = new Set<ProjectSkillStoreRejectReason>([
  "not-ready",
  "state-changed",
  "state-invalid",
  "evidence-mismatch",
  "target-unconfirmed",
  "ref-mismatch",
]);

export function skillLifecycleRejectionNeedsRefetch(
  reason: ProjectSkillStoreRejectReason,
): boolean {
  return LIFECYCLE_REFETCH_REASONS.has(reason);
}

function notReadyRejectionCopy(gaps: unknown): string {
  if (!Array.isArray(gaps) || gaps.length === 0) return STORE_REJECT_COPY["not-ready"];
  const lines = gaps
    .map((gap) =>
      typeof gap === "string"
        ? ((READINESS_GAP_COPY as Record<string, string | undefined>)[gap] ?? null)
        : null,
    )
    .filter((line): line is string => line !== null);
  if (lines.length === 0) return STORE_REJECT_COPY["not-ready"];
  return `${STORE_REJECT_COPY["not-ready"]}\n${lines.join("\n")}`;
}

const SCREEN_REASON_COPY: Record<ProjectSkillScreenReason, string> = {
  sensitive: "The server screened this content: it looks like a secret or credential.",
  "personal-path": "The server screened this content: it contains a personal file path.",
  "verifier-change":
    "The server screened this content: it changes or disables the checks that verify it.",
  "permission-escalation":
    "The server screened this content: it tries to grant itself more permission.",
  "instruction-injection":
    "The server screened this content: it tries to inject instructions to the agent.",
  "native-skill-token": "The server screened this content: it contains native skill markers.",
  "block-delimiter": "The server screened this content: it contains managed-block delimiters.",
};

const SOURCE_REJECT_COPY: Record<ProjectSkillSourceRejectReason, string> = {
  "no-record": "No selected-checks record was found for this source.",
  "record-malformed": "The recorded check data could not be read.",
  "not-all-selected-passed": "The recorded checks did not all pass.",
  "observation-changed": "The recorded checks changed since the candidate was saved.",
  "turn-running": "The agent was still working when the record was checked.",
  "input-after-checks": "New input was recorded after these checks. Run checks again.",
  "project-mismatch": "The record belongs to a different project.",
  "worktree-changed": "The workspace changed after the checks ran.",
  "check-commands-changed": "A recorded action's command changed after the checks ran.",
};

export const SKILL_AUTHORIZATION_COPY =
  "Your session can view skill candidates on this environment but not change them.";
export const SKILL_STORE_FAILURE_COPY = "The server could not save this change. Try again.";
export const SKILL_UNKNOWN_FAILURE_COPY = "The request failed. Try again.";
export const SKILL_NOT_FOUND_COPY = "This skill candidate no longer exists.";

const isTagged = (value: unknown, tag: string): boolean =>
  typeof value === "object" && value !== null && "_tag" in value && value._tag === tag;

/** Typed store errors are recognized by their `_tag` across the wire. */
export const isTaggedError = isTagged;

/**
 * Map lookup for tagged wire data: a reason this build does not know (version
 * skew) falls back to fixed copy instead of formatting `undefined`.
 */
const fixedCopy = <K extends string>(
  map: Record<K, string>,
  key: unknown,
  fallback: string,
): string =>
  typeof key === "string"
    ? ((map as Record<string, string | undefined>)[key] ?? fallback)
    : fallback;

/** Fixed local copy for every skill-write rejection; never echoes a cause. */
export function skillRejectionCopy(cause: unknown): string {
  if (isTagged(cause, "ProjectSkillStoreRejectedError")) {
    const reason = (cause as { reason?: unknown }).reason;
    if (reason === "duplicate-content") {
      const existing = (cause as { existingVersion?: unknown }).existingVersion;
      return typeof existing === "number" && Number.isSafeInteger(existing) && existing >= 1
        ? `Same content as v${existing}`
        : STORE_REJECT_COPY["duplicate-content"];
    }
    if (reason === "screen") {
      const first = (cause as { screenReasons?: unknown }).screenReasons;
      return fixedCopy(
        SCREEN_REASON_COPY,
        Array.isArray(first) ? first[0] : undefined,
        STORE_REJECT_COPY.screen,
      );
    }
    if (reason === "source-ineligible") {
      const sourceReason = (cause as { sourceReason?: unknown }).sourceReason;
      return fixedCopy(SOURCE_REJECT_COPY, sourceReason, STORE_REJECT_COPY["source-ineligible"]);
    }
    if (reason === "not-ready") {
      return notReadyRejectionCopy((cause as { gaps?: unknown }).gaps);
    }
    return fixedCopy(STORE_REJECT_COPY, reason, SKILL_UNKNOWN_FAILURE_COPY);
  }
  // StoreError carries a free-form server message that must never be shown.
  if (isTagged(cause, "ProjectSkillStoreError")) return SKILL_STORE_FAILURE_COPY;
  if (isTagged(cause, "EnvironmentAuthorizationError")) return SKILL_AUTHORIZATION_COPY;
  if (isTagged(cause, "ProjectSkillStoreNotFoundError")) return SKILL_NOT_FOUND_COPY;
  return SKILL_UNKNOWN_FAILURE_COPY;
}

/** The six candidate content fields as entered, before validation. */
export interface SkillContentForm {
  readonly title: string;
  readonly purpose: string;
  readonly appliesWhen: string;
  readonly doesNotApplyWhen: string;
  readonly procedure: string;
  readonly successCheck: string;
}

export const EMPTY_SKILL_CONTENT: SkillContentForm = {
  title: "",
  purpose: "",
  appliesWhen: "",
  doesNotApplyWhen: "",
  procedure: "",
  successCheck: "",
};

/** Trims and validates all six fields against the contract bounds, or null. */
export function toSkillContent(form: SkillContentForm): ProjectSkillContent | null {
  const bounds: Array<{
    key: keyof SkillContentForm;
    max: number;
  }> = [
    { key: "title", max: PROJECT_SKILL_LIMITS.title },
    { key: "purpose", max: PROJECT_SKILL_LIMITS.purpose },
    { key: "appliesWhen", max: PROJECT_SKILL_LIMITS.appliesWhen },
    { key: "doesNotApplyWhen", max: PROJECT_SKILL_LIMITS.doesNotApplyWhen },
    { key: "procedure", max: PROJECT_SKILL_LIMITS.procedure },
    { key: "successCheck", max: PROJECT_SKILL_LIMITS.successCheck },
  ];
  const content: Partial<Record<keyof SkillContentForm, string>> = {};
  for (const { key, max } of bounds) {
    const value = form[key].trim();
    if (value === "" || value.length > max) return null;
    content[key] = value;
  }
  return content as ProjectSkillContent;
}

export const RIGHTS_BASES = [
  "own-work",
  "project-license",
  "third-party-licensed",
  "permission-granted",
] as const;
export type SkillRightsBasis = (typeof RIGHTS_BASES)[number];

export type SkillJudgmentForm =
  | {
      readonly kind: "rights";
      readonly basis: SkillRightsBasis | "";
      readonly originalSource: string;
      readonly license: string;
      readonly note: string;
    }
  | {
      readonly kind: "review";
      readonly provenanceChecked: boolean;
      readonly privacyChecked: boolean;
      readonly scopeChecked: boolean;
      readonly note: string;
    };

const boundedOptional = (value: string, max: number): string | null => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.length > max ? null : trimmed;
};

/**
 * The client-ownable judgment payload, or null when a required choice is
 * missing: the rights basis is never defaulted, the review checkboxes must
 * each be checked, and the note must be nonempty and bounded. Server-owned
 * fields (judgmentId, ref, recordedAt, recordedBy) are never part of this.
 */
export function toRecordableJudgment(
  form: SkillJudgmentForm,
): RecordableProjectSkillJudgment | null {
  const note = form.note.trim();
  if (note === "" || note.length > PROJECT_SKILL_LIMITS.note) return null;
  if (form.kind === "rights") {
    // The empty selection is rejected first so the remaining typed union is
    // exactly the allowed set — no basis is ever defaulted.
    if (form.basis === "" || !RIGHTS_BASES.includes(form.basis)) return null;
    const basis: SkillRightsBasis = form.basis;
    const originalSource = boundedOptional(form.originalSource, PROJECT_SKILL_LIMITS.source);
    const license = boundedOptional(form.license, PROJECT_SKILL_LIMITS.license);
    if (originalSource === null && form.originalSource.trim() !== "") return null;
    if (license === null && form.license.trim() !== "") return null;
    return {
      kind: "rights",
      basis,
      originalSource,
      license,
      note,
    };
  }
  if (!form.provenanceChecked || !form.privacyChecked || !form.scopeChecked) return null;
  return {
    kind: "review",
    provenanceChecked: true,
    privacyChecked: true,
    scopeChecked: true,
    note,
  };
}

/** applied is the only withdraw outcome that counts as a change. */
export const withdrawOutcomeCopy: Record<ProjectSkillWithdrawResult["status"], string> = {
  applied: "Judgment withdrawn",
  "not-found": "That judgment no longer exists on the server.",
  "already-withdrawn": "That judgment was already withdrawn.",
};

/** Delete's plain outcomes; its conflict is a gate, not a toast. */
export const deleteOutcomeCopy: Record<
  Extract<ProjectSkillDeleteResult, { status: "applied" | "not-found" }>["status"],
  string
> = {
  applied: "Skill candidate deleted",
  "not-found": "Already deleted",
};

export const JUDGMENT_KIND_LABEL: Record<ProjectSkillJudgment["kind"], string> = {
  rights: "Rights",
  review: "Review",
  reproduction: "Reproduction",
  "non-application": "Non-application",
  interference: "Interference",
  "failure-classification": "Failure classification",
};

export const RIGHTS_BASIS_LABEL: Record<SkillRightsBasis, string> = {
  "own-work": "Own work",
  "project-license": "Project license",
  "third-party-licensed": "Third-party licensed",
  "permission-granted": "Permission granted",
};

/** One-line summary of what a judgment row records; never a readiness claim. */
export function judgmentSummary(judgment: ProjectSkillJudgment): string {
  if (judgment.kind === "rights") {
    const parts = [`Basis: ${RIGHTS_BASIS_LABEL[judgment.basis]}`];
    if (judgment.originalSource !== null) parts.push(`Source: ${judgment.originalSource}`);
    if (judgment.license !== null) parts.push(`License: ${judgment.license}`);
    return parts.join(" · ");
  }
  if (judgment.kind === "review") {
    return "Provenance, privacy, and scope checked";
  }
  return JUDGMENT_KIND_LABEL[judgment.kind];
}

/** Why skill writes are unavailable, in the order the user can act on it. */
export function resolveSkillWriteLock(
  operateAccess: "granted" | "denied" | "pending",
): string | null {
  if (operateAccess === "pending") {
    return "Checking your access to this environment…";
  }
  if (operateAccess === "denied") {
    return "Your session on this environment can view skill candidates but not change them.";
  }
  return null;
}

/** Version-skew safe: absent or non-boolean trial flag means unsupported. */
export function projectSkillTrialCapabilityOf(
  config:
    | {
        readonly environment: {
          readonly capabilities: {
            readonly projectSkills?: {
              readonly trial?: unknown;
              readonly manage?: unknown;
              readonly lifecycle?: unknown;
              readonly use?: unknown;
            };
          };
        };
      }
    | null
    | undefined,
): boolean {
  return config?.environment.capabilities.projectSkills?.trial === true;
}

/** Version-skew safe: absent or non-true lifecycle means unsupported. */
export function projectSkillLifecycleCapabilityOf(
  config: Parameters<typeof projectSkillTrialCapabilityOf>[0],
): boolean {
  return config?.environment.capabilities.projectSkills?.lifecycle === true;
}

/** Version-skew safe: absent or non-true use means activate/restore are unavailable. */
export function projectSkillUseCapabilityOf(
  config: Parameters<typeof projectSkillTrialCapabilityOf>[0],
): boolean {
  return config?.environment.capabilities.projectSkills?.use === true;
}

export const LIFECYCLE_USE_UNAVAILABLE_COPY =
  "이 환경에서는 스킬 활성화·복원을 사용할 수 없습니다.";

const decodeSelectedScriptIds = Schema.decodeUnknownOption(SelectedChecksRunInput.fields.scriptIds);

/** Nonempty, unique, bounded script ids — same validator as selected-check runs. */
export function freezeSelectedScriptIds(ids: ReadonlyArray<string>): ReadonlyArray<string> | null {
  return Option.getOrNull(decodeSelectedScriptIds(ids));
}

export function selectedScriptsStillValid(
  frozenIds: ReadonlyArray<string>,
  scripts: ReadonlyArray<{ readonly id: string }>,
): boolean {
  const known = new Set(scripts.map((script) => script.id));
  return frozenIds.every((id) => known.has(id));
}

export function sameFrozenScriptIds(a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Absent detail stateSeq is unknown — never coerced to zero. */
export function projectSkillStateSeqOf(detail: ProjectSkillDetail): number | null {
  const seq = detail.stateSeq;
  return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
}

function sourceCreatedAfterEventSequence(source: ProjectSkillSource): number {
  return source.createdAfterEventSequence;
}

function skillSourceCheckThreadId(source: ProjectSkillSource): ThreadId {
  return source.type === "work" ? source.check.threadId : source.root.check.threadId;
}

export function versionViewForRef(
  detail: ProjectSkillDetail,
  ref: ProjectSkillVersionRef,
): ProjectSkillVersionView | null {
  return (
    detail.versions.find((entry) => sameProjectSkillVersionRef(entry.version.ref, ref)) ?? null
  );
}

export interface SkillTrialEvidenceOffer {
  readonly evidenceId: ProjectSkillEvidenceId;
  readonly trial: ProjectSkillTrialSummary & { readonly window: "closed" };
  readonly observation: ProjectSkillTrialObservation;
}

function closedProviderAcceptedObservations(
  trials: ReadonlyArray<ProjectSkillTrialSummary> | undefined,
): ReadonlyArray<SkillTrialEvidenceOffer> {
  if (trials === undefined) return [];
  const offers: SkillTrialEvidenceOffer[] = [];
  for (const trial of trials) {
    if (trial.window !== "closed" || trial.delivery !== "provider-accepted") continue;
    for (const observation of trial.observations) {
      offers.push({
        evidenceId: observation.evidenceId,
        trial: trial as ProjectSkillTrialSummary & { readonly window: "closed" },
        observation,
      });
    }
  }
  return offers;
}

/** Reproduction offers: passed, different thread, input after the version watermark. */
export function reproductionEvidenceOffers(
  view: ProjectSkillVersionView,
): ReadonlyArray<SkillTrialEvidenceOffer> {
  const watermark = sourceCreatedAfterEventSequence(view.version.source);
  const sourceThreadId = skillSourceCheckThreadId(view.version.source);
  return closedProviderAcceptedObservations(view.trials).filter((offer) => {
    if (offer.observation.outcome !== "all-selected-passed") return false;
    if (offer.trial.sameThreadAsSource) return false;
    if (offer.trial.threadId === sourceThreadId) return false;
    return offer.trial.inputEventSequence > watermark;
  });
}

/** Non-application offers: closed provider-accepted observations with durable ids (any outcome). */
export function nonApplicationEvidenceOffers(
  view: ProjectSkillVersionView,
): ReadonlyArray<SkillTrialEvidenceOffer> {
  return closedProviderAcceptedObservations(view.trials);
}

export function findTrialEvidenceOffer(
  view: ProjectSkillVersionView,
  evidenceId: ProjectSkillEvidenceId,
  kind: "reproduction" | "non-application",
): SkillTrialEvidenceOffer | null {
  const offers =
    kind === "reproduction" ? reproductionEvidenceOffers(view) : nonApplicationEvidenceOffers(view);
  return offers.find((offer) => offer.evidenceId === evidenceId) ?? null;
}

export function evidenceOfferForSelectValue(
  offers: ReadonlyArray<SkillTrialEvidenceOffer>,
  value: string,
): SkillTrialEvidenceOffer | null {
  if (value === "") return null;
  return offers.find((offer) => offer.evidenceId === value) ?? null;
}

export interface FrozenTrialEvidenceChoice {
  readonly evidenceId: ProjectSkillEvidenceId;
  readonly attemptId: string;
  readonly receiptSequence: number;
  readonly inputEventSequence: number;
  readonly outcome: ProjectSkillTrialObservation["outcome"];
  readonly trialThreadId: ThreadId;
  readonly trialMessageId: ProjectSkillTrialSummary["messageId"];
}

export function freezeTrialEvidenceChoice(
  offer: SkillTrialEvidenceOffer,
): FrozenTrialEvidenceChoice {
  return {
    evidenceId: offer.evidenceId,
    attemptId: offer.observation.attemptId,
    receiptSequence: offer.observation.receiptSequence,
    inputEventSequence: offer.trial.inputEventSequence,
    outcome: offer.observation.outcome,
    trialThreadId: offer.trial.threadId,
    trialMessageId: offer.trial.messageId,
  };
}

export function sameFrozenTrialEvidenceChoice(
  a: FrozenTrialEvidenceChoice,
  b: FrozenTrialEvidenceChoice,
): boolean {
  return (
    a.evidenceId === b.evidenceId &&
    a.attemptId === b.attemptId &&
    a.receiptSequence === b.receiptSequence &&
    a.inputEventSequence === b.inputEventSequence &&
    a.outcome === b.outcome &&
    a.trialThreadId === b.trialThreadId &&
    a.trialMessageId === b.trialMessageId
  );
}

export function trialEvidenceChoiceStillValid(
  view: ProjectSkillVersionView,
  choice: FrozenTrialEvidenceChoice,
  kind: "reproduction" | "non-application",
): boolean {
  const offer = findTrialEvidenceOffer(view, choice.evidenceId, kind);
  if (offer === null) return false;
  return sameFrozenTrialEvidenceChoice(choice, freezeTrialEvidenceChoice(offer));
}

export interface FrozenProjectScriptBinding {
  readonly id: string;
  readonly command: string;
}

export function freezeProjectScriptBindings(
  scripts: ReadonlyArray<{ readonly id: string; readonly command: string }>,
  selectedIds: ReadonlyArray<string>,
): ReadonlyArray<FrozenProjectScriptBinding> | null {
  const frozenIds = freezeSelectedScriptIds(selectedIds);
  if (frozenIds === null) return null;
  const byId = new Map(scripts.map((script) => [script.id, script]));
  const bindings: FrozenProjectScriptBinding[] = [];
  for (const id of frozenIds) {
    const script = byId.get(id);
    if (script === undefined) return null;
    bindings.push({ id: script.id, command: script.command });
  }
  return bindings;
}

export function projectScriptsMatchBindings(
  scripts: ReadonlyArray<{ readonly id: string; readonly command: string }>,
  bindings: ReadonlyArray<FrozenProjectScriptBinding>,
): boolean {
  if (bindings.length === 0) return false;
  const byId = new Map(scripts.map((script) => [script.id, script]));
  for (const binding of bindings) {
    const current = byId.get(binding.id);
    if (current === undefined || current.command !== binding.command) return false;
  }
  return true;
}

export interface LifecycleTargetSelection {
  readonly threadId: ThreadId;
  readonly scriptIds: ReadonlyArray<string>;
}

export function lifecycleTargetSelectionMatches(
  frozen: LifecycleTargetSelection,
  current: LifecycleTargetSelection,
): boolean {
  return (
    frozen.threadId === current.threadId && sameFrozenScriptIds(frozen.scriptIds, current.scriptIds)
  );
}

export interface SkillReproductionForm {
  readonly observedEvidenceId: ProjectSkillEvidenceId | "";
  readonly procedureApplied: boolean;
  readonly successConditionConfirmed: boolean;
  readonly taskNotUsedForAuthoring: boolean;
  readonly note: string;
}

export interface SkillNonApplicationForm {
  readonly observedEvidenceId: ProjectSkillEvidenceId | "";
  readonly taskDescription: string;
  readonly verdict: "correctly-not-applied" | "harmful" | "";
  readonly note: string;
}

export function toRecordableReproduction(
  form: SkillReproductionForm,
): Extract<RecordableProjectSkillJudgment, { kind: "reproduction" }> | null {
  const note = form.note.trim();
  if (note === "" || note.length > PROJECT_SKILL_LIMITS.note) return null;
  if (form.observedEvidenceId === "") return null;
  if (!form.procedureApplied || !form.successConditionConfirmed || !form.taskNotUsedForAuthoring) {
    return null;
  }
  return {
    kind: "reproduction",
    observedEvidenceId: form.observedEvidenceId,
    procedureApplied: true,
    successConditionConfirmed: true,
    taskNotUsedForAuthoring: true,
    note,
  };
}

export function toRecordableNonApplication(
  form: SkillNonApplicationForm,
): Extract<RecordableProjectSkillJudgment, { kind: "non-application" }> | null {
  const note = form.note.trim();
  const taskDescription = form.taskDescription.trim();
  if (note === "" || note.length > PROJECT_SKILL_LIMITS.note) return null;
  if (taskDescription === "") return null;
  if (form.observedEvidenceId === "") return null;
  if (form.verdict !== "correctly-not-applied" && form.verdict !== "harmful") return null;
  return {
    kind: "non-application",
    observedEvidenceId: form.observedEvidenceId,
    taskDescription,
    verdict: form.verdict,
    note,
  };
}

export interface FrozenLifecycleActivate {
  readonly ref: ProjectSkillVersionRef;
  readonly expectedStateSeq: number;
  readonly expectedVersionState: ProjectSkillVersionState;
  readonly projectId: ProjectSkillVersionRef["projectId"];
  readonly threadId: ThreadId;
  readonly threadCreatedAt: string;
  readonly scriptBindings: ReadonlyArray<FrozenProjectScriptBinding>;
  readonly target: LifecycleTargetSelection;
}

export interface FrozenLifecycleRetire {
  readonly ref: ProjectSkillVersionRef;
  readonly expectedStateSeq: number;
  readonly expectedVersionState: "active";
  readonly projectId: ProjectSkillVersionRef["projectId"];
}

export function lifecycleVersionPinStillCurrent(
  detail: ProjectSkillDetail,
  skillId: ProjectSkillVersionRef["skillId"],
  projectId: ProjectSkillVersionRef["projectId"],
  frozen: {
    readonly ref: ProjectSkillVersionRef;
    readonly expectedStateSeq: number;
    readonly expectedVersionState: ProjectSkillVersionState;
  },
): boolean {
  if (detail.projectId !== projectId || detail.skillId !== skillId) return false;
  const seq = projectSkillStateSeqOf(detail);
  if (seq === null || seq !== frozen.expectedStateSeq) return false;
  const view = versionViewForRef(detail, frozen.ref);
  return view !== null && view.version.state === frozen.expectedVersionState;
}

export function lifecycleThreadScopeStillValid(
  shell: {
    readonly id: ThreadId;
    readonly projectId: ProjectSkillVersionRef["projectId"];
    readonly createdAt: string;
    readonly archivedAt: string | null;
  } | null,
  frozen: Pick<FrozenLifecycleActivate, "threadId" | "threadCreatedAt" | "projectId">,
): boolean {
  if (shell === null) return false;
  if (shell.id !== frozen.threadId) return false;
  if (shell.projectId !== frozen.projectId) return false;
  if (shell.archivedAt !== null) return false;
  return shell.createdAt === frozen.threadCreatedAt;
}

export function lifecycleActivateOperationStillValid(input: {
  readonly detail: ProjectSkillDetail;
  readonly skillId: ProjectSkillVersionRef["skillId"];
  readonly project: { readonly id: ProjectSkillVersionRef["projectId"] } | null;
  readonly threadShell: {
    readonly id: ThreadId;
    readonly projectId: ProjectSkillVersionRef["projectId"];
    readonly createdAt: string;
    readonly archivedAt: string | null;
  } | null;
  readonly scripts: ReadonlyArray<{ readonly id: string; readonly command: string }>;
  readonly frozen: FrozenLifecycleActivate;
  readonly selection: LifecycleTargetSelection;
}): boolean {
  if (input.project === null || input.project.id !== input.frozen.projectId) return false;
  if (
    !lifecycleVersionPinStillCurrent(input.detail, input.skillId, input.frozen.projectId, {
      ref: input.frozen.ref,
      expectedStateSeq: input.frozen.expectedStateSeq,
      expectedVersionState: input.frozen.expectedVersionState,
    })
  ) {
    return false;
  }
  if (!lifecycleThreadScopeStillValid(input.threadShell, input.frozen)) return false;
  if (!projectScriptsMatchBindings(input.scripts, input.frozen.scriptBindings)) return false;
  return lifecycleTargetSelectionMatches(input.frozen.target, input.selection);
}

export function lifecycleRetireOperationStillValid(input: {
  readonly detail: ProjectSkillDetail;
  readonly skillId: ProjectSkillVersionRef["skillId"];
  readonly frozen: FrozenLifecycleRetire;
}): boolean {
  return lifecycleVersionPinStillCurrent(input.detail, input.skillId, input.frozen.projectId, {
    ref: input.frozen.ref,
    expectedStateSeq: input.frozen.expectedStateSeq,
    expectedVersionState: input.frozen.expectedVersionState,
  });
}

export const LIFECYCLE_UNSUPPORTED_COPY = "이 서버는 스킬 활성화·중지를 지원하지 않습니다.";
export const LIFECYCLE_STATE_UNKNOWN_COPY =
  "프로젝트 스킬 상태를 알 수 없습니다. 서버가 수명주기를 지원할 때만 활성화할 수 있습니다.";
export const LIFECYCLE_SCOPE_DRIFT_COPY =
  "선택이나 버전 정보가 바뀌었습니다. 다시 확인한 뒤 시도해 주세요.";
export const LIFECYCLE_SCRIPTS_INVALID_COPY = "실행할 스크립트를 하나 이상 선택해 주세요.";
export const LIFECYCLE_THREAD_REQUIRED_COPY = "스레드를 선택해 주세요.";
export const LIFECYCLE_JUDGMENT_INVALID_COPY = "필수 항목을 모두 입력·선택해 주세요.";
export const LIFECYCLE_ACTIVATE_SUCCESS = "버전이 활성화되었습니다";
export const LIFECYCLE_RESTORE_SUCCESS = "이전 버전이 복원되었습니다";
export const LIFECYCLE_RETIRE_SUCCESS = "사용이 중지되었습니다";
export const LIFECYCLE_REPRODUCTION_RECORDED = "재현 판단이 기록되었습니다";
export const LIFECYCLE_NON_APPLICATION_RECORDED = "비적용 판단이 기록되었습니다";

export const VERSION_TRIAL_HISTORY_TITLE = "Trials";
export const VERSION_TRIAL_HISTORY_UNAVAILABLE_COPY =
  "Trial history is unavailable for this version.";
export const VERSION_TRIAL_HISTORY_EMPTY_COPY = "No trials recorded for this version.";
const VERSION_TRIAL_DELIVERY_UNKNOWN_COPY =
  "Delivery unconfirmed — the provider send may or may not have completed.";
const VERSION_TRIAL_DELIVERY_ACCEPTED_COPY = "Provider send returned (not task or check success).";
const VERSION_TRIAL_SAME_THREAD_COPY =
  "Ran in this version's source thread (not independent reproduction).";
const VERSION_TRIAL_OTHER_THREAD_COPY = "Ran in a different thread.";
const VERSION_TRIAL_WINDOW_OPEN_COPY = "Window open — observations below are provisional.";
const VERSION_TRIAL_WINDOW_RECREATED_COPY =
  "Thread was recreated during the trial window; no fixed observation range.";
const VERSION_TRIAL_UNCOUNTED_COPY = (count: number) =>
  `Uncounted boundary attempts: ${count} (not reported as success or failure).`;

export interface VersionTrialHistoryRow {
  readonly key: string;
  readonly headline: string;
  readonly lines: ReadonlyArray<string>;
}

export type VersionTrialHistoryPanel =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "empty" }
  | { readonly kind: "listed"; readonly rows: ReadonlyArray<VersionTrialHistoryRow> };

const trialObservationLine = (
  label: string,
  observation: ProjectSkillTrialProvisionalObservation,
): string => {
  const ended =
    observation.endedAt !== null ? ` · ended ${observation.endedAt}` : " · end time unavailable";
  return `${label} ${observation.attemptId} · seq ${observation.receiptSequence} · ${observation.outcome}${ended}`;
};

/** One trial row from the version view API; never implies reproduction evidence. */
export function formatVersionTrialRow(trial: ProjectSkillTrialSummary): VersionTrialHistoryRow {
  const deliveryLine =
    trial.delivery === "unknown"
      ? VERSION_TRIAL_DELIVERY_UNKNOWN_COPY
      : VERSION_TRIAL_DELIVERY_ACCEPTED_COPY;
  const threadLine = trial.sameThreadAsSource
    ? VERSION_TRIAL_SAME_THREAD_COPY
    : VERSION_TRIAL_OTHER_THREAD_COPY;
  const lines: string[] = [
    deliveryLine,
    threadLine,
    `Input event seq ${trial.inputEventSequence} · admitted state seq ${trial.admittedSkillStateSeq}`,
  ];
  if (trial.window === "open") {
    lines.push(VERSION_TRIAL_WINDOW_OPEN_COPY);
    for (const observation of trial.provisionalObservations) {
      lines.push(trialObservationLine("Provisional:", observation));
    }
  } else if (trial.window === "closed") {
    for (const observation of trial.observations) {
      lines.push(trialObservationLine(`Observation (${observation.evidenceId}):`, observation));
    }
    if (trial.uncountedAttempts > 0) {
      lines.push(VERSION_TRIAL_UNCOUNTED_COPY(trial.uncountedAttempts));
    }
  } else {
    lines.push(VERSION_TRIAL_WINDOW_RECREATED_COPY);
  }
  const driver = trial.providerDriverKind !== null ? ` · driver ${trial.providerDriverKind}` : "";
  return {
    key: trial.messageId,
    headline: `Trial ${trial.messageId}${driver}`,
    lines,
  };
}

/**
 * How to render per-version trial history from `ProjectSkillVersionView.trials`.
 * Absent `trials` is unavailable (not an empty list). The panel stays hidden
 * until the server advertises the trial capability.
 */
export function versionTrialHistoryPanel(input: {
  readonly trialCapability: boolean;
  readonly trials?: ReadonlyArray<ProjectSkillTrialSummary> | undefined;
}): VersionTrialHistoryPanel {
  if (!input.trialCapability) return { kind: "hidden" };
  if (input.trials === undefined) return { kind: "unavailable" };
  if (input.trials.length === 0) return { kind: "empty" };
  return { kind: "listed", rows: input.trials.map(formatVersionTrialRow) };
}

export const CANDIDATE_NOTICE =
  "You write this procedure. It is saved as an inactive candidate. Fill exclusions yourself — nothing is inferred about rights, privacy, or when not to apply. Only when you choose Draft from accepted work does the server re-verify the accepted source at save.";

export const CANDIDATE_DERIVE_OPTION_COPY =
  "Optional: draft from accepted work copies only an explicit Procedure or Steps section from that result. Review and generalize it, then fill exclusions before saving.";

export const CANDIDATE_PROCEDURE_UNTRUSTED_COPY =
  "Copied procedure text is untrusted until you review it and screening runs at save.";

export const DERIVE_UNAVAILABLE_COPY: Record<ProjectSkillReviewDraftUnavailableReason, string> = {
  "no-coherent-source":
    "This accepted source could not be bound for a draft. Run checks again from a coherent accepted result.",
  "no-procedure-section":
    "This accepted result has no explicit Procedure or Steps section to copy — for example a Done or summary-only reply.",
  "procedure-empty": "The Procedure or Steps section had no numbered or bulleted steps to copy.",
  "procedure-ambiguous":
    "The message has more than one Procedure or Steps section, so no single section could be copied.",
};

const TRUNCATION_FIELD_LABEL: Record<keyof ProjectSkillReviewDraftTruncation, string> = {
  title: "title",
  purpose: "purpose",
  appliesWhen: "applies when",
  procedure: "procedure",
  successCheck: "success check",
};

/** Fixed local copy for a successful derive's truncation metadata. */
export function derivationTruncationNotice(
  truncation: ProjectSkillReviewDraftTruncation,
): string | null {
  const labels = (
    Object.keys(TRUNCATION_FIELD_LABEL) as Array<keyof ProjectSkillReviewDraftTruncation>
  )
    .filter((key) => truncation[key] === true)
    .map((key) => TRUNCATION_FIELD_LABEL[key]);
  if (labels.length === 0) return null;
  return `Some copied fields were truncated to fit limits (${labels.join(", ")}). Review before saving.`;
}

/** Succinct provenance for the server-prepared source pin — no raw message bodies. */
export function derivedSourceProvenanceLines(
  source: ProjectSkillCandidateSourceIdentity,
): ReadonlyArray<string> {
  return [
    `Source pin ${source.wholeSourceSha256.slice(0, 12)}…`,
    `Check attempt ${source.acceptedCheck.attemptId} · revision ${source.acceptedCheck.revision} · receipt seq ${source.acceptedCheck.receiptSequence}`,
    `Turn ${source.turnId} · assistant message ${source.assistantMessageId}`,
  ];
}

/**
 * Merge a server partial into the form without overwriting fields the user
 * already edited. The initial success-check prefill is not treated as edited.
 */
export function mergeDerivePartialIntoForm(
  form: SkillContentForm,
  partial: ProjectSkillReviewDraftPartial,
  touched: ReadonlySet<keyof SkillContentForm>,
): SkillContentForm {
  const pick = (key: keyof SkillContentForm, value: string) =>
    touched.has(key) ? form[key] : value;
  return {
    title: pick("title", partial.title),
    purpose: pick("purpose", partial.purpose),
    appliesWhen: pick("appliesWhen", partial.appliesWhen),
    doesNotApplyWhen: form.doesNotApplyWhen,
    procedure: pick("procedure", partial.procedure),
    successCheck: pick("successCheck", partial.successCheck),
  };
}

export function projectSkillGeneratedDraftCapabilityOf(
  config:
    | { environment: { capabilities: { projectSkills?: { generatedDraft?: boolean } } } }
    | null
    | undefined,
): boolean {
  return config?.environment.capabilities.projectSkills?.generatedDraft === true;
}
