import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  MessageId,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import {
  GitTreeOid,
  SafePositiveInt,
  SelectedCheckPlannedCheck,
  SelectedChecksRunInput,
  Sha256Hex,
} from "./selectedChecks.ts";

/**
 * Project skills are managed procedure blocks: a user saves a candidate from
 * work they did, an authenticated client records review judgments against an
 * exact version, and the server admits a versioned block into a message only
 * when the pure policy here reports it ready. This module holds the contracts
 * and the pure functions; storage, admission, and hold bookkeeping stay on
 * the server. Nothing here claims a current worktree state — a check
 * observation is a historical claim about one attempt window.
 */

export const PROJECT_SKILL_LIMITS = {
  title: 120,
  purpose: 500,
  appliesWhen: 1000,
  doesNotApplyWhen: 1000,
  procedure: 6000,
  successCheck: 1000,
  note: 1000,
  source: 500,
  license: 100,
} as const;

/** Bounded integers for event sequences and revisions that must round-trip a JS number. */
const SafeNonNegInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/** Same bound the selected-checks receipt puts on its attempt id (private there). */
const CheckAttemptId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

export const PROJECT_SKILL_REVIEW_DRAFT_DERIVATION_FORMAT =
  "oop-project-skill-review-draft-source/v1";

/**
 * The check tuple a derive or save request names — the receipt write the
 * caller observed. The server rebuilds the observation and exact-compares.
 */
export const ProjectSkillExpectedCheckTuple = Schema.Struct({
  attemptId: CheckAttemptId,
  revision: SafeNonNegInt,
  receiptSequence: SafeNonNegInt,
});
export type ProjectSkillExpectedCheckTuple = typeof ProjectSkillExpectedCheckTuple.Type;

const projectSkillCandidateSourceSeedFields = {
  derivationFormat: Schema.Literal(PROJECT_SKILL_REVIEW_DRAFT_DERIVATION_FORMAT),
  projectId: ProjectId,
  projectIncarnationSequence: SafeNonNegInt,
  threadId: ThreadId,
  threadIncarnationSequence: SafeNonNegInt,
  turnId: TurnId,
  assistantMessageId: MessageId,
  requestMessageId: MessageId,
  assistantBodySha256: Sha256Hex,
  requestBodySha256: Sha256Hex,
  extractedProcedureSha256: Sha256Hex,
  requirementsVersion: SafePositiveInt,
  requirementsContentSha256: Sha256Hex,
  taskResultRecordSequence: SafeNonNegInt,
  taskResultRecordRevision: SafeNonNegInt,
  taskResultRecordSha256: Sha256Hex,
  acceptedCheck: ProjectSkillExpectedCheckTuple,
  currentCheck: ProjectSkillExpectedCheckTuple,
  threadTitleSha256: Sha256Hex,
  boundRequirementTextSha256: Sha256Hex,
  boundSuccessCheckTextSha256: Sha256Hex,
} as const;

/**
 * Canonical preimage for `wholeSourceSha256`. The server hashes this JSON
 * (domain prefix, fixed key order) and stores the digest on the identity.
 * Client pins only `wholeSourceSha256` on save — never authority.
 */
export function canonicalProjectSkillCandidateSourceSeedJson(
  seed: ProjectSkillCandidateSourceSeed,
): string {
  return (
    `${PROJECT_SKILL_REVIEW_DRAFT_DERIVATION_FORMAT}\n` +
    JSON.stringify({
      derivationFormat: seed.derivationFormat,
      projectId: seed.projectId,
      projectIncarnationSequence: seed.projectIncarnationSequence,
      threadId: seed.threadId,
      threadIncarnationSequence: seed.threadIncarnationSequence,
      turnId: seed.turnId,
      assistantMessageId: seed.assistantMessageId,
      requestMessageId: seed.requestMessageId,
      assistantBodySha256: seed.assistantBodySha256,
      requestBodySha256: seed.requestBodySha256,
      extractedProcedureSha256: seed.extractedProcedureSha256,
      requirementsVersion: seed.requirementsVersion,
      requirementsContentSha256: seed.requirementsContentSha256,
      taskResultRecordSequence: seed.taskResultRecordSequence,
      taskResultRecordRevision: seed.taskResultRecordRevision,
      taskResultRecordSha256: seed.taskResultRecordSha256,
      acceptedCheck: {
        attemptId: seed.acceptedCheck.attemptId,
        revision: seed.acceptedCheck.revision,
        receiptSequence: seed.acceptedCheck.receiptSequence,
      },
      currentCheck: {
        attemptId: seed.currentCheck.attemptId,
        revision: seed.currentCheck.revision,
        receiptSequence: seed.currentCheck.receiptSequence,
      },
      threadTitleSha256: seed.threadTitleSha256,
      boundRequirementTextSha256: seed.boundRequirementTextSha256,
      boundSuccessCheckTextSha256: seed.boundSuccessCheckTextSha256,
    })
  );
}

export const ProjectSkillCandidateSourceSeed = Schema.Struct(projectSkillCandidateSourceSeedFields);
export type ProjectSkillCandidateSourceSeed = typeof ProjectSkillCandidateSourceSeed.Type;

/**
 * One frozen accepted assistant source the server prepared for a review
 * draft. Every hash names bytes the server measured; the client may echo
 * `wholeSourceSha256` as an equality expectation only.
 */
export const ProjectSkillCandidateSourceIdentity = Schema.Struct({
  ...projectSkillCandidateSourceSeedFields,
  wholeSourceSha256: Sha256Hex,
});
export type ProjectSkillCandidateSourceIdentity = typeof ProjectSkillCandidateSourceIdentity.Type;

export const ProjectSkillId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^psk_[a-z0-9]{8,40}$/),
).pipe(Schema.brand("ProjectSkillId"));
export type ProjectSkillId = typeof ProjectSkillId.Type;

export const ProjectSkillJudgmentId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectSkillJudgmentId"),
);
export type ProjectSkillJudgmentId = typeof ProjectSkillJudgmentId.Type;

export const ProjectSkillHoldId = TrimmedNonEmptyString.pipe(Schema.brand("ProjectSkillHoldId"));
export type ProjectSkillHoldId = typeof ProjectSkillHoldId.Type;

export const ProjectSkillEvidenceId = TrimmedNonEmptyString.pipe(
  Schema.brand("ProjectSkillEvidenceId"),
);
export type ProjectSkillEvidenceId = typeof ProjectSkillEvidenceId.Type;

const ContentField = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

/**
 * The procedure body one version pins. Fields compare as the code points
 * entered — no Unicode normalization.
 */
export const ProjectSkillContent = Schema.Struct({
  title: ContentField(PROJECT_SKILL_LIMITS.title),
  purpose: ContentField(PROJECT_SKILL_LIMITS.purpose),
  appliesWhen: ContentField(PROJECT_SKILL_LIMITS.appliesWhen),
  doesNotApplyWhen: ContentField(PROJECT_SKILL_LIMITS.doesNotApplyWhen),
  procedure: ContentField(PROJECT_SKILL_LIMITS.procedure),
  successCheck: ContentField(PROJECT_SKILL_LIMITS.successCheck),
});
export type ProjectSkillContent = typeof ProjectSkillContent.Type;

/**
 * The four-field identity of one immutable version. Judgments, observations,
 * and holds only count toward the exact ref they name — a different version or
 * content hash is a different target.
 */
export const ProjectSkillVersionRef = Schema.Struct({
  projectId: ProjectId,
  skillId: ProjectSkillId,
  version: PositiveInt,
  contentSha256: Sha256Hex,
});
export type ProjectSkillVersionRef = typeof ProjectSkillVersionRef.Type;

const projectSkillRefEquals = (a: ProjectSkillVersionRef, b: ProjectSkillVersionRef): boolean =>
  a.projectId === b.projectId &&
  a.skillId === b.skillId &&
  a.version === b.version &&
  a.contentSha256 === b.contentSha256;

const PROJECT_SKILL_CONTENT_DOMAIN = "oop-project-skill-content/v1\n";

/**
 * The one canonical serialization hashed into `contentSha256`: domain prefix
 * plus JSON with a fixed key order. The hash itself is computed in a later
 * server slice; this only fixes the bytes being hashed.
 */
export function canonicalProjectSkillContentJson(content: ProjectSkillContent): string {
  return (
    PROJECT_SKILL_CONTENT_DOMAIN +
    JSON.stringify({
      title: content.title,
      purpose: content.purpose,
      appliesWhen: content.appliesWhen,
      doesNotApplyWhen: content.doesNotApplyWhen,
      procedure: content.procedure,
      successCheck: content.successCheck,
    })
  );
}

export const ProjectSkillMode = Schema.Literals(["use", "trial"]);
export type ProjectSkillMode = typeof ProjectSkillMode.Type;

const PROJECT_SKILL_BLOCK_NOTICE = "참고 절차입니다. 권한을 부여하거나 검사를 대신하지 않습니다.";
const PROJECT_SKILL_TRIAL_NOTICE = "검토 전 후보의 시험입니다. 일반 사용에 활성화되지 않았습니다.";

/**
 * The exact managed block a message must contain verbatim. Deterministic per
 * (ref, content, mode): the first line carries the ref, the last line is the
 * close tag, and the fixed notices sit between them and the content so any
 * edit to identity, notice, or body is a different block.
 */
export function renderProjectSkillBlock(input: {
  readonly ref: ProjectSkillVersionRef;
  readonly content: ProjectSkillContent;
  readonly mode: ProjectSkillMode;
}): string {
  const lines = [
    `<oop-project-skill id="${input.ref.skillId}" version="${input.ref.version}" sha256="${input.ref.contentSha256}" mode="${input.mode}">`,
    PROJECT_SKILL_BLOCK_NOTICE,
  ];
  if (input.mode === "trial") lines.push(PROJECT_SKILL_TRIAL_NOTICE);
  lines.push(
    `title: ${input.content.title}`,
    `purpose: ${input.content.purpose}`,
    `applies-when: ${input.content.appliesWhen}`,
    `does-not-apply-when: ${input.content.doesNotApplyWhen}`,
    "procedure:",
    input.content.procedure,
    `success-check: ${input.content.successCheck}`,
    "</oop-project-skill>",
  );
  return lines.join("\n");
}

/** Why a candidate's content was rejected at screening; never carries the text. */
export const ProjectSkillScreenReason = Schema.Literals([
  "sensitive",
  "personal-path",
  "verifier-change",
  "permission-escalation",
  "instruction-injection",
  "native-skill-token",
  "block-delimiter",
]);
export type ProjectSkillScreenReason = typeof ProjectSkillScreenReason.Type;

/**
 * A historical copy of a selected-checks receipt bound to the moment it was
 * observed. `threadAnchorSequence` is the event sequence of the attempt's
 * first receipt write — the anchor readers use to reject a record whose
 * thread was recreated after the attempt began, not a thread incarnation id.
 * A `failed` outcome is grounds for a hold, never for approval; passing
 * requires the ending tree and repository identity it was proven on.
 */
export const ProjectSkillCheckObservation = Schema.Struct({
  threadId: ThreadId,
  threadAnchorSequence: SafeNonNegInt,
  receiptSequence: SafeNonNegInt,
  attemptId: CheckAttemptId,
  revision: SafeNonNegInt,
  projectId: ProjectId,
  workspaceRoot: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  envSha256: Sha256Hex,
  planned: Schema.Array(SelectedCheckPlannedCheck),
  tree: Schema.NullOr(
    Schema.Struct({
      treeOid: GitTreeOid,
      repoTopLevel: Schema.String,
      repoCommonDir: Schema.String,
    }),
  ),
  environment: Schema.Struct({
    environmentId: EnvironmentId,
    platform: Schema.String,
    arch: Schema.String,
    osRelease: Schema.String,
    serverVersion: Schema.String,
    nodeVersion: Schema.String,
  }),
  startedAt: Schema.String,
  endedAt: Schema.NullOr(Schema.String),
  outcome: Schema.Literals(["all-selected-passed", "failed"]),
}).check(
  Schema.makeFilter(
    (observation) =>
      observation.outcome !== "all-selected-passed" ||
      (observation.tree !== null && observation.endedAt !== null),
  ),
);
export type ProjectSkillCheckObservation = typeof ProjectSkillCheckObservation.Type;

/**
 * The evidence kind a reproduction claim, environment, or hold carries.
 * Records stored before managed evidence existed carry no scope and mean the
 * legacy `native-inventory` claim; a scope is never inferred from a null
 * field or a passing check.
 */
export const ProjectSkillEvidenceScope = Schema.Literals([
  "native-inventory",
  "managed-procedure/v1",
]);
export type ProjectSkillEvidenceScope = typeof ProjectSkillEvidenceScope.Type;

/** Absent storage reads as the legacy scope; only an explicit scope marks managed evidence. */
const effectiveEvidenceScope = (
  scope: ProjectSkillEvidenceScope | undefined,
): ProjectSkillEvidenceScope => scope ?? "native-inventory";

const isProjectSkillEvidenceScope = Schema.is(ProjectSkillEvidenceScope);
const isSha256Hex = Schema.is(Sha256Hex);

/**
 * Whether an environment satisfies its evidence-scope branch: the scope must
 * be a supported literal or absent (legacy), the legacy scope never carries
 * the managed route digest, and the managed scope replaces the native
 * inventory with a real digest. Shared by the schema filter and the pure
 * predicates so a typed value that never decoded fails closed.
 */
const environmentScopeConsistent = (environment: ProjectSkillEnvironment): boolean => {
  // Two equally malformed records must never compare equal to `none`.
  if (environment.scope !== undefined && !isProjectSkillEvidenceScope(environment.scope)) {
    return false;
  }
  if (environment.routeConfigSha256 !== undefined && !isSha256Hex(environment.routeConfigSha256)) {
    return false;
  }
  return effectiveEvidenceScope(environment.scope) === "native-inventory"
    ? environment.routeConfigSha256 === undefined
    : environment.nativeSkillInventorySha256 === null &&
        environment.providerDriverKind !== null &&
        environment.routeConfigSha256 !== undefined;
};

/**
 * Server-captured evidence that one send delivered the exact managed procedure
 * block for `deliveredRef` through a concrete provider instance and session.
 * No producer writes this yet: decode establishes structure, never
 * authenticated provenance, and a client-supplied digest alone proves no
 * send happened.
 */
export const ProjectSkillManagedSendEvidence = Schema.Struct({
  scope: Schema.Literal("managed-procedure/v1"),
  deliveredRef: ProjectSkillVersionRef,
  deliveredBlockSha256: Sha256Hex,
  providerInstanceId: TrimmedNonEmptyString,
  providerSessionId: TrimmedNonEmptyString,
  routeConfigSha256: Sha256Hex,
});
export type ProjectSkillManagedSendEvidence = typeof ProjectSkillManagedSendEvidence.Type;

/** Compiled branch guard for managed evidence handed over as a typed value. */
const isProjectSkillManagedSendEvidence = Schema.is(ProjectSkillManagedSendEvidence);

/**
 * One user input the server accepted carrying project-skill records.
 * `inputEventSequence` is the sequence of the committed user-input acceptance
 * event in this server's event domain — every real user input counts, not
 * just turn starts. `providerDriverKind`/`nativeSkillInventorySha256` are null
 * when unconfirmed, and unconfirmed fields can never support a reproduction
 * claim. `managedSend` is present only when the server captured the managed
 * send for one delivered item; absence keeps the strict legacy meaning, and a
 * null inventory never becomes managed evidence on its own.
 */
export const ProjectSkillInputObservation = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  messageId: MessageId,
  inputEventSequence: SafeNonNegInt,
  admittedSkillStateSeq: SafeNonNegInt,
  providerDriverKind: Schema.NullOr(TrimmedNonEmptyString),
  nativeSkillInventorySha256: Schema.NullOr(Sha256Hex),
  items: Schema.Array(Schema.Struct({ ref: ProjectSkillVersionRef, mode: ProjectSkillMode })),
  managedSend: Schema.optionalKey(ProjectSkillManagedSendEvidence),
}).check(
  Schema.makeFilter((observation) => {
    const managedSend = observation.managedSend;
    if (managedSend === undefined) return true;
    return (
      observation.nativeSkillInventorySha256 === null &&
      observation.providerDriverKind !== null &&
      observation.items.some((item) => projectSkillRefEquals(item.ref, managedSend.deliveredRef))
    );
  }),
);
export type ProjectSkillInputObservation = typeof ProjectSkillInputObservation.Type;

const ProjectSkillWorkSource = Schema.Struct({
  type: Schema.Literal("work"),
  check: ProjectSkillCheckObservation,
  /**
   * Server event high-water mark at the moment this version was created, in
   * the same sequence domain as `inputEventSequence`. Reproduction evidence
   * must postdate it so a candidate can never be its own reproduction.
   */
  createdAfterEventSequence: SafeNonNegInt,
  draft: Schema.Union([
    Schema.Struct({ type: Schema.Literal("typed") }),
    Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }),
    Schema.Struct({
      type: Schema.Literal("derived"),
      messageId: MessageId,
      sourceIdentity: ProjectSkillCandidateSourceIdentity,
      /** Whether any draft field differed from the server-derived seed at save. */
      edited: Schema.Boolean,
    }),
  ]),
});

/**
 * Where a version came from. `work` records the passed check the candidate
 * was saved from; `revision` points at the version it revises and keeps the
 * lineage's original work source in `root`.
 */
export const ProjectSkillSource = Schema.Union([
  ProjectSkillWorkSource,
  Schema.Struct({
    type: Schema.Literal("revision"),
    fromVersion: PositiveInt,
    createdAfterEventSequence: SafeNonNegInt,
    root: ProjectSkillWorkSource,
  }),
]);
export type ProjectSkillSource = typeof ProjectSkillSource.Type;

/**
 * A use window the server observed: the accepted input plus the check it
 * produced when the window closed with a check run, else null.
 */
export const ProjectSkillObservedUse = Schema.Struct({
  evidenceId: ProjectSkillEvidenceId,
  input: ProjectSkillInputObservation,
  check: Schema.NullOr(ProjectSkillCheckObservation),
});
export type ProjectSkillObservedUse = typeof ProjectSkillObservedUse.Type;

const ProjectSkillJudgmentBaseFields = {
  judgmentId: ProjectSkillJudgmentId,
  ref: ProjectSkillVersionRef,
  recordedAt: IsoDateTime,
  recordedBy: Schema.Literal("authenticated-client"),
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.note)),
} as const;

/**
 * Decisions an authenticated client recorded against an exact version. These
 * are review claims, never server observations: `recordedBy` says who
 * recorded, not what a human verified. `Literal(true)` fields exist because a
 * check that did not happen cannot be written down — decoding rejects false.
 */
export const ProjectSkillJudgment = Schema.Union([
  Schema.Struct({
    ...ProjectSkillJudgmentBaseFields,
    kind: Schema.Literal("rights"),
    basis: Schema.Literals([
      "own-work",
      "project-license",
      "third-party-licensed",
      "permission-granted",
    ]),
    originalSource: Schema.NullOr(
      Schema.String.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.source)),
    ),
    license: Schema.NullOr(Schema.String.check(Schema.isMaxLength(PROJECT_SKILL_LIMITS.license))),
  }),
  Schema.Struct({
    ...ProjectSkillJudgmentBaseFields,
    kind: Schema.Literal("review"),
    provenanceChecked: Schema.Literal(true),
    privacyChecked: Schema.Literal(true),
    scopeChecked: Schema.Literal(true),
  }),
  Schema.Struct({
    ...ProjectSkillJudgmentBaseFields,
    kind: Schema.Literal("reproduction"),
    observedEvidenceId: ProjectSkillEvidenceId,
    procedureApplied: Schema.Literal(true),
    successConditionConfirmed: Schema.Literal(true),
    taskNotUsedForAuthoring: Schema.Literal(true),
  }),
  Schema.Struct({
    ...ProjectSkillJudgmentBaseFields,
    kind: Schema.Literal("non-application"),
    observedEvidenceId: ProjectSkillEvidenceId,
    taskDescription: TrimmedNonEmptyString,
    verdict: Schema.Literals(["correctly-not-applied", "harmful"]),
  }),
  Schema.Struct({
    ...ProjectSkillJudgmentBaseFields,
    kind: Schema.Literal("interference"),
    observedEvidenceId: ProjectSkillEvidenceId,
    coActive: Schema.Array(ProjectSkillVersionRef).check(Schema.isMinLength(1)),
    verdict: Schema.Literals(["no-interference-observed", "interference"]),
  }),
  Schema.Struct({
    ...ProjectSkillJudgmentBaseFields,
    kind: Schema.Literal("failure-classification"),
    holdId: ProjectSkillHoldId,
    classification: Schema.Literals(["unrelated", "skill-caused"]),
  }),
]);
export type ProjectSkillJudgment = typeof ProjectSkillJudgment.Type;

/**
 * The narrow environment a reproduction is valid for. `checkCommands` compare
 * as a per-scriptId set, so reordered plans of the same commands are not an
 * environment change. `osRelease`/`serverVersion`/`nodeVersion` are recorded
 * on the check observation but intentionally not compared — that is the
 * documented narrowness of this support claim. `scope` names the evidence
 * kind: absent (or `native-inventory`) is the legacy native-inventory claim,
 * while `managed-procedure/v1` carries `routeConfigSha256` in place of the
 * unknown native inventory. `scope` is declared rather than tolerated as an
 * excess key so a managed record cannot decode silently as legacy.
 */
export const ProjectSkillEnvironment = Schema.Struct({
  platform: Schema.String,
  arch: Schema.String,
  envSha256: Sha256Hex,
  checkCommands: Schema.Array(
    Schema.Struct({ scriptId: TrimmedNonEmptyString, commandSha256: Sha256Hex }),
  ),
  providerDriverKind: Schema.NullOr(Schema.String),
  nativeSkillInventorySha256: Schema.NullOr(Sha256Hex),
  scope: Schema.optionalKey(ProjectSkillEvidenceScope),
  routeConfigSha256: Schema.optionalKey(Sha256Hex),
}).check(Schema.makeFilter(environmentScopeConsistent));
export type ProjectSkillEnvironment = typeof ProjectSkillEnvironment.Type;

/**
 * A standing block on a version: a use window that observed a failure, or an
 * environment the version never reproduced on. `observedAtEventSequence`
 * bounds what a releasing reproduction must postdate. `evidenceScope` names
 * the evidence kind the hold was raised under — absent means the legacy
 * scope, and a failure hold with a null environment is managed only through
 * this explicit scope. A non-null `environment` must carry the same scope.
 */
export const ProjectSkillHold = Schema.Struct({
  holdId: ProjectSkillHoldId,
  ref: ProjectSkillVersionRef,
  kind: Schema.Literals(["failure-observed", "environment-changed"]),
  observedAtEventSequence: SafeNonNegInt,
  failure: Schema.NullOr(ProjectSkillCheckObservation),
  environment: Schema.NullOr(ProjectSkillEnvironment),
  evidenceScope: Schema.optionalKey(ProjectSkillEvidenceScope),
}).check(
  Schema.makeFilter(
    (hold) =>
      hold.environment === null ||
      effectiveEvidenceScope(hold.environment.scope) === effectiveEvidenceScope(hold.evidenceScope),
  ),
);
export type ProjectSkillHold = typeof ProjectSkillHold.Type;

export const ProjectSkillRetiredReason = Schema.Literals([
  "superseded",
  "user-retired",
  "environment-changed",
  "failed-in-use",
  "rejected",
]);
export type ProjectSkillRetiredReason = typeof ProjectSkillRetiredReason.Type;

export const ProjectSkillVersionState = Schema.Literals(["candidate", "active", "retired"]);
export type ProjectSkillVersionState = typeof ProjectSkillVersionState.Type;

export const PROJECT_SKILL_CONTEXT_KIND = "project-skill";

/**
 * The payload a `project-skill` context record carries. The server overwrites
 * `admittedSkillStateSeq` at admission; a client-sent value is never trusted.
 *
 * When present, `selectedScriptIds` is durable caller selection of which
 * scripts to run — not readiness or admission authority. Use consumers MUST
 * reject payloads where it is absent; that gate is not enforced here so older
 * trial payloads remain decodable.
 */
export const ProjectSkillContextPayload = Schema.Struct({
  ref: ProjectSkillVersionRef,
  mode: ProjectSkillMode,
  admittedSkillStateSeq: Schema.optionalKey(SafeNonNegInt),
  selectedScriptIds: Schema.optionalKey(SelectedChecksRunInput.fields.scriptIds),
});
export type ProjectSkillContextPayload = typeof ProjectSkillContextPayload.Type;

/** The version a readiness or hold-release answer is about. */
export interface ProjectSkillTarget {
  readonly ref: ProjectSkillVersionRef;
  readonly state: ProjectSkillVersionState;
  readonly retiredReason: ProjectSkillRetiredReason | null;
  readonly source: ProjectSkillSource;
}

const PROJECT_SKILL_READINESS_GAP_ORDER = [
  "state",
  "screen",
  "rights-unreviewed",
  "review-missing",
  "reproduction-missing",
  "non-application-missing",
  "non-application-harmful",
  "interference-missing",
  "interference-observed",
  "open-hold",
  "unsupported-provider",
  "environment-changed",
] as const;

export const ProjectSkillReadinessGap = Schema.Literals([...PROJECT_SKILL_READINESS_GAP_ORDER]);
export type ProjectSkillReadinessGap = typeof ProjectSkillReadinessGap.Type;

const projectSkillRefKey = (ref: ProjectSkillVersionRef): string =>
  JSON.stringify([ref.projectId, ref.skillId, ref.version, ref.contentSha256]);

/** Set equality on full refs: same distinct members regardless of order. */
const projectSkillRefSetEquals = (
  a: ReadonlyArray<ProjectSkillVersionRef>,
  b: ReadonlyArray<ProjectSkillVersionRef>,
): boolean => {
  const aKeys = new Set(a.map(projectSkillRefKey));
  const bKeys = new Set(b.map(projectSkillRefKey));
  if (aKeys.size !== bKeys.size) return false;
  for (const key of aKeys) if (!bKeys.has(key)) return false;
  return true;
};

type CheckCommand = { readonly scriptId: string; readonly commandSha256: string };

/** Per-scriptId set in deterministic order: dedupe on first occurrence, then sort. */
const canonicalCheckCommands = (
  commands: ReadonlyArray<CheckCommand>,
): ReadonlyArray<CheckCommand> => {
  const byScriptId = new Map<string, string>();
  for (const command of commands) {
    if (!byScriptId.has(command.scriptId)) byScriptId.set(command.scriptId, command.commandSha256);
  }
  return [...byScriptId.entries()]
    .map(([scriptId, commandSha256]) => ({ scriptId, commandSha256 }))
    .sort((a, b) => (a.scriptId < b.scriptId ? -1 : a.scriptId > b.scriptId ? 1 : 0));
};

/**
 * The environment a passed use establishes, or null when the use passed no
 * checks or its provider driver / native skill inventory was not confirmed.
 * An unconfirmed field never produces a support claim. A use carrying
 * `managedSend` establishes the managed scope instead: its native inventory
 * is unknown by definition, so the route digest stands in for it, and the
 * attempt provenance (instance/session ids, block bytes) never becomes an
 * environment field.
 */
export function projectSkillEnvironmentOf(
  use: ProjectSkillObservedUse,
): ProjectSkillEnvironment | null {
  const check = use.check;
  if (check === null || check.outcome !== "all-selected-passed") return null;
  const managedSend = use.input.managedSend;
  if (managedSend !== undefined) {
    // Branch eligibility is re-checked here rather than assumed from decode:
    // typed values in memory are not guaranteed to have passed the schema,
    // and the compiled guard does not run TrimmedString's trim transform.
    if (
      use.input.nativeSkillInventorySha256 !== null ||
      use.input.providerDriverKind === null ||
      !isProjectSkillManagedSendEvidence(managedSend) ||
      managedSend.providerInstanceId.trim().length === 0 ||
      managedSend.providerSessionId.trim().length === 0 ||
      !use.input.items.some((item) => projectSkillRefEquals(item.ref, managedSend.deliveredRef))
    ) {
      return null;
    }
    return {
      platform: check.environment.platform,
      arch: check.environment.arch,
      envSha256: check.envSha256,
      checkCommands: canonicalCheckCommands(check.planned),
      providerDriverKind: use.input.providerDriverKind,
      nativeSkillInventorySha256: null,
      scope: "managed-procedure/v1",
      routeConfigSha256: managedSend.routeConfigSha256,
    };
  }
  if (use.input.providerDriverKind === null || use.input.nativeSkillInventorySha256 === null) {
    return null;
  }
  return {
    platform: check.environment.platform,
    arch: check.environment.arch,
    envSha256: check.envSha256,
    checkCommands: canonicalCheckCommands(check.planned),
    providerDriverKind: use.input.providerDriverKind,
    nativeSkillInventorySha256: use.input.nativeSkillInventorySha256,
  };
}

// Evidence scope gates equality first: a managed and a legacy environment are
// never the same support claim. Attempt provenance (provider session, block
// bytes) is deliberately absent from environments — separate attempts in one
// environment must stay equal for separate-task reproduction to be reachable.
const projectSkillEnvironmentEquals = (
  a: ProjectSkillEnvironment,
  b: ProjectSkillEnvironment,
): boolean => {
  if (effectiveEvidenceScope(a.scope) !== effectiveEvidenceScope(b.scope)) return false;
  if (
    a.platform !== b.platform ||
    a.arch !== b.arch ||
    a.envSha256 !== b.envSha256 ||
    a.providerDriverKind !== b.providerDriverKind ||
    a.nativeSkillInventorySha256 !== b.nativeSkillInventorySha256 ||
    a.routeConfigSha256 !== b.routeConfigSha256
  ) {
    return false;
  }
  const aCommands = canonicalCheckCommands(a.checkCommands);
  const bCommands = canonicalCheckCommands(b.checkCommands);
  return (
    aCommands.length === bCommands.length &&
    aCommands.every((command, index) => {
      const other = bCommands[index];
      return (
        other !== undefined &&
        command.scriptId === other.scriptId &&
        command.commandSha256 === other.commandSha256
      );
    })
  );
};

/**
 * How `current` compares to the environments a version reproduced on. `none`
 * needs every compared field equal — including the evidence scope, so a
 * managed current never matches a legacy reproduction or vice versa. An
 * unconfirmed current can never be `none`: a null driver is
 * `unsupported-provider`, while a null legacy inventory or a managed current
 * without its route digest is `environment-changed`. A driver kind outside
 * the supported set is `unsupported-provider` ahead of any scope or field
 * drift; any other drift is `environment-changed`. Branch-ineligible
 * environments fail closed on either side: a typed value that never decoded
 * — a null scope is never read as absent — can never produce `none`.
 */
export function projectSkillEnvironmentMismatch(input: {
  readonly supported: ReadonlyArray<ProjectSkillEnvironment>;
  readonly current: ProjectSkillEnvironment;
}): "none" | "unsupported-provider" | "environment-changed" {
  const { supported, current } = input;
  if (current.providerDriverKind === null) return "unsupported-provider";
  if (
    !supported.some((environment) => environment.providerDriverKind === current.providerDriverKind)
  ) {
    return "unsupported-provider";
  }
  // A typed current that fails its own evidence branch is refused outright —
  // a null scope is not an absent one — before any normalization or equality.
  if (!environmentScopeConsistent(current)) return "environment-changed";
  if (
    effectiveEvidenceScope(current.scope) === "native-inventory" &&
    current.nativeSkillInventorySha256 === null
  ) {
    return "environment-changed";
  }
  // Typed values in memory are not guaranteed to have passed decode, so an
  // ill-formed environment is skipped even when an equally ill-formed
  // counterpart would otherwise compare equal.
  return supported.some(
    (environment) =>
      environmentScopeConsistent(environment) &&
      projectSkillEnvironmentEquals(environment, current),
  )
    ? "none"
    : "environment-changed";
}

type ReproductionCandidateResult =
  | { readonly outcome: "eligible" }
  | {
      readonly outcome: "environment-failed";
      readonly environment: ProjectSkillEnvironment | null;
    }
  | { readonly outcome: "ineligible" };

/**
 * The one eligibility predicate shared by readiness and hold release: the
 * reproduction judgment names the target's full ref, its observed use's input
 * actually carries that ref, a carried managed send names that same ref, the
 * check passed in the input's own thread and project, that thread differs
 * from the source's, the input postdates the version's creation watermark,
 * and the environment the use establishes matches `current`. A candidate
 * passing every other leg but failing the environment is `environment-failed`
 * and yields the environment it ran on, so callers can aggregate the
 * supported set rather than report a mismatch that depends on candidate
 * order.
 */
const evaluateReproductionCandidate = (input: {
  readonly target: ProjectSkillTarget;
  readonly current: ProjectSkillEnvironment;
  readonly judgment: ProjectSkillJudgment;
  readonly use: ProjectSkillObservedUse;
}): ReproductionCandidateResult => {
  const { target, judgment, use } = input;
  if (judgment.kind !== "reproduction") return { outcome: "ineligible" };
  if (!projectSkillRefEquals(judgment.ref, target.ref)) return { outcome: "ineligible" };
  if (judgment.observedEvidenceId !== use.evidenceId) return { outcome: "ineligible" };
  const check = use.check;
  if (check === null || check.outcome !== "all-selected-passed") {
    return { outcome: "ineligible" };
  }
  if (use.input.threadId !== check.threadId) return { outcome: "ineligible" };
  if (use.input.projectId !== target.ref.projectId || check.projectId !== target.ref.projectId) {
    return { outcome: "ineligible" };
  }
  if (!use.input.items.some((item) => projectSkillRefEquals(item.ref, target.ref))) {
    return { outcome: "ineligible" };
  }
  const managedSend = use.input.managedSend;
  if (
    managedSend !== undefined &&
    // Validate before dereferencing: hand-built evidence may be malformed.
    (!isProjectSkillManagedSendEvidence(managedSend) ||
      !projectSkillRefEquals(managedSend.deliveredRef, target.ref))
  ) {
    return { outcome: "ineligible" };
  }
  const sourceThreadId =
    target.source.type === "work"
      ? target.source.check.threadId
      : target.source.root.check.threadId;
  if (use.input.threadId === sourceThreadId) return { outcome: "ineligible" };
  if (use.input.inputEventSequence <= target.source.createdAfterEventSequence) {
    return { outcome: "ineligible" };
  }
  const environment = projectSkillEnvironmentOf(use);
  if (environment === null) return { outcome: "environment-failed", environment: null };
  const mismatch = projectSkillEnvironmentMismatch({
    supported: [environment],
    current: input.current,
  });
  return mismatch === "none"
    ? { outcome: "eligible" }
    : { outcome: "environment-failed", environment };
};

/**
 * Whether a hold on the target no longer blocks it. Release always needs an
 * eligible reproduction whose input postdates the hold's observation; a
 * `failure-observed` hold also needs an `unrelated` classification on the same
 * hold and ref. A `skill-caused` classification on the same hold and ref is
 * permanent — the version needs a revision, not a release. The hold's own
 * non-null environment must be branch-valid and agree with its evidence
 * scope, the scope must match the current, and an eligible reproduction
 * necessarily ran in the current's scope, so a new managed reproduction
 * cannot release an old unmarked hold and vice versa. Nothing else
 * (dismissal words, other refs' holds, stale environments) releases a hold.
 */
export function isProjectSkillHoldReleased(input: {
  readonly hold: ProjectSkillHold;
  readonly target: ProjectSkillTarget;
  readonly current: ProjectSkillEnvironment;
  readonly judgments: ReadonlyArray<ProjectSkillJudgment>;
  readonly observedUses: ReadonlyArray<ProjectSkillObservedUse>;
}): boolean {
  const { hold, target, current, judgments, observedUses } = input;
  if (!projectSkillRefEquals(hold.ref, target.ref)) return false;
  if (hold.evidenceScope !== undefined && !isProjectSkillEvidenceScope(hold.evidenceScope)) {
    return false;
  }
  const holdScope = effectiveEvidenceScope(hold.evidenceScope);
  if (
    hold.environment !== null &&
    (!environmentScopeConsistent(hold.environment) ||
      effectiveEvidenceScope(hold.environment.scope) !== holdScope)
  ) {
    return false;
  }
  if (holdScope !== effectiveEvidenceScope(current.scope)) {
    return false;
  }
  const isClassification = (
    judgment: ProjectSkillJudgment,
    classification: "unrelated" | "skill-caused",
  ) =>
    judgment.kind === "failure-classification" &&
    judgment.holdId === hold.holdId &&
    projectSkillRefEquals(judgment.ref, target.ref) &&
    judgment.classification === classification;
  if (judgments.some((judgment) => isClassification(judgment, "skill-caused"))) return false;
  if (
    hold.kind === "failure-observed" &&
    !judgments.some((judgment) => isClassification(judgment, "unrelated"))
  ) {
    return false;
  }
  return judgments.some((judgment) => {
    if (judgment.kind !== "reproduction") return false;
    const use = observedUses.find((use) => use.evidenceId === judgment.observedEvidenceId);
    return (
      use !== undefined &&
      use.input.inputEventSequence > hold.observedAtEventSequence &&
      evaluateReproductionCandidate({ target, current, judgment, use }).outcome === "eligible"
    );
  });
}

const judgmentIsKind =
  <Kind extends ProjectSkillJudgment["kind"]>(
    kind: Kind,
  ): ((
    judgment: ProjectSkillJudgment,
  ) => judgment is Extract<ProjectSkillJudgment, { kind: Kind }>) =>
  (judgment): judgment is Extract<ProjectSkillJudgment, { kind: Kind }> =>
    judgment.kind === kind;

/**
 * Whether the target may be used or activated now, and the gaps that block
 * it. Fails closed: every condition must be proven by judgments, observations,
 * and holds bound to the exact ref. Gaps are deduplicated in enum order and
 * `ready` is exactly `gaps.length === 0`.
 */
export function deriveProjectSkillReadiness(input: {
  readonly purpose: "activate" | "use";
  readonly target: ProjectSkillTarget;
  readonly screenReasons: ReadonlyArray<ProjectSkillScreenReason>;
  readonly observedUses: ReadonlyArray<ProjectSkillObservedUse>;
  readonly judgments: ReadonlyArray<ProjectSkillJudgment>;
  readonly holds: ReadonlyArray<ProjectSkillHold>;
  readonly otherActive: ReadonlyArray<ProjectSkillVersionRef>;
  readonly current: ProjectSkillEnvironment;
}): { readonly ready: boolean; readonly gaps: ReadonlyArray<ProjectSkillReadinessGap> } {
  const { purpose, target, current } = input;
  const gapSet = new Set<ProjectSkillReadinessGap>();

  const stateOk =
    purpose === "use"
      ? target.state === "active"
      : target.state === "candidate" ||
        (target.state === "retired" &&
          (target.retiredReason === "superseded" ||
            target.retiredReason === "user-retired" ||
            target.retiredReason === "environment-changed"));
  if (!stateOk) gapSet.add("state");

  if (input.screenReasons.length > 0) gapSet.add("screen");

  const boundJudgments = input.judgments.filter((judgment) =>
    projectSkillRefEquals(judgment.ref, target.ref),
  );
  const useByEvidenceId = new Map(input.observedUses.map((use) => [use.evidenceId, use] as const));

  if (!boundJudgments.some((judgment) => judgment.kind === "rights")) {
    gapSet.add("rights-unreviewed");
  }
  if (!boundJudgments.some((judgment) => judgment.kind === "review")) {
    gapSet.add("review-missing");
  }

  let reproductionEligible = false;
  let sawUnconfirmableEnvironment = false;
  const reproductionEnvironments: Array<ProjectSkillEnvironment> = [];
  for (const judgment of boundJudgments) {
    if (judgment.kind !== "reproduction") continue;
    const use = useByEvidenceId.get(judgment.observedEvidenceId);
    if (use === undefined) continue;
    const result = evaluateReproductionCandidate({ target, current, judgment, use });
    if (result.outcome === "eligible") {
      reproductionEligible = true;
      break;
    }
    if (result.outcome === "environment-failed") {
      if (result.environment === null) sawUnconfirmableEnvironment = true;
      else reproductionEnvironments.push(result.environment);
    }
  }
  if (!reproductionEligible) {
    if (reproductionEnvironments.length > 0) {
      // The aggregated supported set decides the gap, so candidate order
      // cannot flip the answer: an exact match would have been eligible, a
      // same-driver drift is environment-changed, and only a current driver
      // absent from every reproduced environment is unsupported-provider.
      const mismatch = projectSkillEnvironmentMismatch({
        supported: reproductionEnvironments,
        current,
      });
      gapSet.add(mismatch === "none" ? "reproduction-missing" : mismatch);
    } else {
      gapSet.add(sawUnconfirmableEnvironment ? "environment-changed" : "reproduction-missing");
    }
  }

  const nonApplicationJudgments = boundJudgments.filter(judgmentIsKind("non-application"));
  const nonApplicationOk = nonApplicationJudgments.some((judgment) => {
    if (judgment.verdict !== "correctly-not-applied") return false;
    const use = useByEvidenceId.get(judgment.observedEvidenceId);
    return (
      use !== undefined &&
      use.input.items.some((item) => projectSkillRefEquals(item.ref, target.ref))
    );
  });
  if (!nonApplicationOk) gapSet.add("non-application-missing");
  if (nonApplicationJudgments.some((judgment) => judgment.verdict === "harmful")) {
    gapSet.add("non-application-harmful");
  }

  if (input.otherActive.length > 0) {
    const interferenceJudgments = boundJudgments.filter(judgmentIsKind("interference"));
    if (
      interferenceJudgments.some(
        (judgment) =>
          judgment.verdict === "interference" &&
          judgment.coActive.some((coActive) =>
            input.otherActive.some((other) => projectSkillRefEquals(coActive, other)),
          ),
      )
    ) {
      gapSet.add("interference-observed");
    }
    const interferenceCleared = interferenceJudgments.some((judgment) => {
      if (judgment.verdict !== "no-interference-observed") return false;
      if (!projectSkillRefSetEquals(judgment.coActive, input.otherActive)) return false;
      const use = useByEvidenceId.get(judgment.observedEvidenceId);
      if (use === undefined || use.check === null) return false;
      if (use.check.outcome !== "all-selected-passed") return false;
      return [target.ref, ...judgment.coActive].every((required) =>
        use.input.items.some((item) => projectSkillRefEquals(item.ref, required)),
      );
    });
    if (!interferenceCleared) gapSet.add("interference-missing");
  }

  const openHold = input.holds.some(
    (hold) =>
      projectSkillRefEquals(hold.ref, target.ref) &&
      !isProjectSkillHoldReleased({
        hold,
        target,
        current,
        judgments: input.judgments,
        observedUses: input.observedUses,
      }),
  );
  if (openHold) gapSet.add("open-hold");

  const gaps = PROJECT_SKILL_READINESS_GAP_ORDER.filter((gap) => gapSet.has(gap));
  return { ready: gaps.length === 0, gaps };
}
