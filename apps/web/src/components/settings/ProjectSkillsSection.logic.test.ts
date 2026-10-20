// Pure decision tests for the skill-candidates UI: the checks-source gate,
// the fixed rejection copy (nothing user-submitted or server-side may leak
// through), the judgment/content validation bounds, and the outcome maps.
import { describe, expect, it } from "vite-plus/test";
import {
  MessageId,
  PROJECT_SKILL_LIMITS,
  ProjectId,
  ProjectSkillEvidenceId,
  ProjectSkillId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  ProjectSkillCheckObservation,
  ProjectSkillJudgment,
  ProjectSkillScreenReason,
  ProjectSkillSourceRejectReason,
  ProjectSkillStoreRejectReason,
  ProjectSkillTrialSummary,
  ProjectSkillVersionView,
  SelectedCheckReceipt,
} from "@t3tools/contracts";
import type { SelectedChecksView } from "@t3tools/client-runtime/state/selected-checks-control";

import {
  deleteOutcomeCopy,
  judgmentSummary,
  resolveSkillWriteLock,
  type SkillContentForm,
  type SkillJudgmentForm,
  skillRejectionCopy,
  skillSourceFromChecks,
  successCheckPrefill,
  toRecordableJudgment,
  toSkillContent,
  withdrawOutcomeCopy,
  RIGHTS_BASES,
  VERSION_TRIAL_HISTORY_EMPTY_COPY,
  VERSION_TRIAL_HISTORY_UNAVAILABLE_COPY,
  formatVersionTrialRow,
  findTrialEvidenceOffer,
  nonApplicationEvidenceOffers,
  projectSkillLifecycleCapabilityOf,
  projectSkillUseCapabilityOf,
  LIFECYCLE_USE_UNAVAILABLE_COPY,
  projectSkillStateSeqOf,
  projectSkillTrialCapabilityOf,
  READINESS_GAP_COPY,
  reproductionEvidenceOffers,
  skillLifecycleRejectionNeedsRefetch,
  derivationTruncationNotice,
  mergeDerivePartialIntoForm,
  projectSkillGeneratedDraftCapabilityOf,
  toRecordableNonApplication,
  toRecordableReproduction,
  versionTrialHistoryPanel,
} from "./ProjectSkillsSection.logic";
import type { ProjectSkillReadinessGap } from "@t3tools/contracts";
// The source gate reads only the attempt identity and revision off the
// receipt; the rest of the schema is irrelevant to this decision.
const receipt = { attemptId: "attempt-1", revision: 3 } as SelectedCheckReceipt;

const passingView = (overrides: Partial<SelectedChecksView> = {}): SelectedChecksView => ({
  open: true,
  headline: "passed",
  hasCurrentAuthority: true,
  getInFlight: false,
  getError: null,
  record: { receipt, sequence: 42 },
  recordAuthority: "current",
  derived: null,
  live: null,
  liveIsNewer: false,
  admission: null,
  capability: null,
  changedScriptIds: [],
  comparisonStale: false,
  newerTurnAfterRecord: false,
  selection: [],
  pendingRunAttemptId: null,
  commandInFlight: null,
  notice: null,
  stopAttemptId: null,
  canRun: true,
  canStop: false,
  canRecover: false,
  dialog: null,
  dialogSubmit: null,
  ...overrides,
});

const sourceInput = (
  view: SelectedChecksView,
  overrides: { permission?: "allowed" | "read-only" | "unknown"; manage?: boolean } = {},
) => ({
  view,
  permission: overrides.permission ?? ("allowed" as const),
  manage: overrides.manage ?? true,
});

describe("skillSourceFromChecks", () => {
  it("returns the exact receipt tuple from a passed current record", () => {
    expect(skillSourceFromChecks(sourceInput(passingView()))).toEqual({
      attemptId: "attempt-1",
      revision: 3,
      receiptSequence: 42,
    });
  });

  it("returns null when a single gate condition fails", () => {
    expect(
      skillSourceFromChecks({ view: passingView(), permission: "allowed", manage: false }),
    ).toBeNull();
    expect(
      skillSourceFromChecks({ view: passingView(), permission: "read-only", manage: true }),
    ).toBeNull();
    expect(
      skillSourceFromChecks({ view: passingView(), permission: "unknown", manage: true }),
    ).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ headline: "failed" })))).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ headline: "incomplete" })))).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ recordAuthority: "live" })))).toBeNull();
    expect(
      skillSourceFromChecks(sourceInput(passingView({ recordAuthority: "previous" }))),
    ).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ recordAuthority: null })))).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ record: null })))).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ getInFlight: true })))).toBeNull();
    expect(
      skillSourceFromChecks(sourceInput(passingView({ getError: "The request failed." }))),
    ).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ comparisonStale: true })))).toBeNull();
    expect(
      skillSourceFromChecks(sourceInput(passingView({ newerTurnAfterRecord: true }))),
    ).toBeNull();
    expect(
      skillSourceFromChecks(sourceInput(passingView({ changedScriptIds: ["script-1"] }))),
    ).toBeNull();
    expect(skillSourceFromChecks(sourceInput(passingView({ commandInFlight: "run" })))).toBeNull();
    expect(
      skillSourceFromChecks(sourceInput(passingView({ record: { receipt, sequence: null } }))),
    ).toBeNull();
  });
});

const SENTINEL = "SENTINEL-USER-CONTENT-LEAK";

describe("skillRejectionCopy", () => {
  const storeReasons: ProjectSkillStoreRejectReason[] = [
    "screen",
    "source-ineligible",
    "source-changed",
    "thread-missing",
    "project-missing",
    "draft-message-invalid",
    "judgment-kind-unavailable",
    "ref-mismatch",
    "duplicate-content",
    "not-ready",
    "state-changed",
    "state-invalid",
    "evidence-mismatch",
    "target-unconfirmed",
  ];

  it("has fixed copy for every store rejection reason", () => {
    for (const reason of storeReasons) {
      const copy = skillRejectionCopy({ _tag: "ProjectSkillStoreRejectedError", reason });
      expect(copy.length).toBeGreaterThan(0);
      expect(copy).not.toContain(SENTINEL);
    }
  });

  it("maps the first screen reason and every screen reason", () => {
    const screenReasons: ProjectSkillScreenReason[] = [
      "sensitive",
      "personal-path",
      "verifier-change",
      "permission-escalation",
      "instruction-injection",
      "native-skill-token",
      "block-delimiter",
    ];
    for (const screenReason of screenReasons) {
      const copy = skillRejectionCopy({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "screen",
        screenReasons: [screenReason],
      });
      expect(copy).toContain("screened");
    }
    expect(
      skillRejectionCopy({ _tag: "ProjectSkillStoreRejectedError", reason: "screen" }).length,
    ).toBeGreaterThan(0);
  });

  it("maps every source reason under source-ineligible, including input-after-checks", () => {
    const sourceReasons: ProjectSkillSourceRejectReason[] = [
      "no-record",
      "record-malformed",
      "not-all-selected-passed",
      "observation-changed",
      "turn-running",
      "input-after-checks",
      "project-mismatch",
      "worktree-changed",
      "check-commands-changed",
    ];
    for (const sourceReason of sourceReasons) {
      expect(
        skillRejectionCopy({
          _tag: "ProjectSkillStoreRejectedError",
          reason: "source-ineligible",
          sourceReason,
        }).length,
      ).toBeGreaterThan(0);
    }
    expect(
      skillRejectionCopy({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "source-ineligible",
        sourceReason: "input-after-checks",
      }),
    ).toBe("New input was recorded after these checks. Run checks again.");
  });

  it("names the existing version for duplicate content", () => {
    expect(
      skillRejectionCopy({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "duplicate-content",
        existingVersion: 4,
      }),
    ).toBe("Same content as v4");
  });

  it("does not format an invalid duplicate version as a version claim", () => {
    for (const existingVersion of [0, -2, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(
        skillRejectionCopy({
          _tag: "ProjectSkillStoreRejectedError",
          reason: "duplicate-content",
          existingVersion,
        }),
      ).toBe("Same content as an existing version.");
    }
  });

  it("falls back to fixed copy for an unknown reason in any tagged family", () => {
    expect(
      skillRejectionCopy({ _tag: "ProjectSkillStoreRejectedError", reason: "made-up-reason" }),
    ).toBe("The request failed. Try again.");
    expect(
      skillRejectionCopy({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "screen",
        screenReasons: ["made-up-screen"],
      }),
    ).toBe("The server screened this content and declined to save it.");
    expect(
      skillRejectionCopy({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "source-ineligible",
        sourceReason: "made-up-source",
      }),
    ).toBe(
      "The passed record no longer qualifies. Run the checks again and save from the new record.",
    );
  });

  it("never echoes a StoreError message, a cause, or submitted content", () => {
    expect(skillRejectionCopy({ _tag: "ProjectSkillStoreError", message: SENTINEL })).not.toContain(
      SENTINEL,
    );
    expect(skillRejectionCopy(new Error(`${SENTINEL} boom`))).not.toContain(SENTINEL);
    expect(skillRejectionCopy(`raw ${SENTINEL}`)).not.toContain(SENTINEL);
    expect(skillRejectionCopy(undefined)).not.toContain(SENTINEL);
  });

  it("recognizes authorization loss separately from transport failure", () => {
    const authorization = skillRejectionCopy({ _tag: "EnvironmentAuthorizationError" });
    expect(authorization).toContain("view skill candidates");
    expect(skillRejectionCopy({ _tag: "ProjectSkillStoreNotFoundError" })).toContain(
      "no longer exists",
    );
    expect(skillRejectionCopy(new Error(SENTINEL))).not.toBe(authorization);
  });
});

const validContent: SkillContentForm = {
  title: "  Deploy the staging bundle  ",
  purpose: "Ship a reviewed build",
  appliesWhen: "When staging is behind",
  doesNotApplyWhen: "When production",
  procedure: "1. Build\n2. Deploy",
  successCheck: "Selected checks pass: lint, test",
};

describe("toSkillContent", () => {
  it("trims every field and keeps the code-point values", () => {
    expect(toSkillContent(validContent)).toEqual({
      title: "Deploy the staging bundle",
      purpose: "Ship a reviewed build",
      appliesWhen: "When staging is behind",
      doesNotApplyWhen: "When production",
      procedure: "1. Build\n2. Deploy",
      successCheck: "Selected checks pass: lint, test",
    });
  });

  it("rejects empty or whitespace-only fields", () => {
    for (const key of Object.keys(validContent) as Array<keyof SkillContentForm>) {
      expect(toSkillContent({ ...validContent, [key]: "   " })).toBeNull();
      expect(toSkillContent({ ...validContent, [key]: "" })).toBeNull();
    }
  });

  it("enforces each contract bound, including successCheck at 1000", () => {
    expect(toSkillContent({ ...validContent, title: "a".repeat(121) })).toBeNull();
    expect(toSkillContent({ ...validContent, title: "a".repeat(120) })).not.toBeNull();
    expect(toSkillContent({ ...validContent, purpose: "a".repeat(501) })).toBeNull();
    expect(toSkillContent({ ...validContent, appliesWhen: "a".repeat(1001) })).toBeNull();
    expect(toSkillContent({ ...validContent, doesNotApplyWhen: "a".repeat(1001) })).toBeNull();
    expect(toSkillContent({ ...validContent, procedure: "a".repeat(6001) })).toBeNull();
    expect(toSkillContent({ ...validContent, successCheck: "a".repeat(1001) })).toBeNull();
    expect(toSkillContent({ ...validContent, successCheck: "a".repeat(1000) })).not.toBeNull();
  });
});

const rightsForm = (
  overrides: Partial<Extract<SkillJudgmentForm, { kind: "rights" }>> = {},
): SkillJudgmentForm => ({
  kind: "rights",
  basis: "own-work",
  originalSource: "",
  license: "",
  note: "wrote it myself",
  ...overrides,
});

const reviewForm = (
  overrides: Partial<Extract<SkillJudgmentForm, { kind: "review" }>> = {},
): SkillJudgmentForm => ({
  kind: "review",
  provenanceChecked: true,
  privacyChecked: true,
  scopeChecked: true,
  note: "looked at all of it",
  ...overrides,
});

describe("toRecordableJudgment", () => {
  it("keeps only the client fields a rights judgment owns", () => {
    const judgment = toRecordableJudgment(rightsForm({ originalSource: "  upstream docs  " }));
    expect(judgment).toEqual({
      kind: "rights",
      basis: "own-work",
      originalSource: "upstream docs",
      license: null,
      note: "wrote it myself",
    });
    expect(Object.keys(judgment!)).toEqual(["kind", "basis", "originalSource", "license", "note"]);
  });

  it("requires a deliberate rights basis — none is defaulted", () => {
    expect(toRecordableJudgment(rightsForm({ basis: "" }))).toBeNull();
    expect(toRecordableJudgment(rightsForm({ basis: "made-up" as never }))).toBeNull();
    for (const basis of RIGHTS_BASES) {
      expect(toRecordableJudgment(rightsForm({ basis }))?.kind).toBe("rights");
    }
  });

  it("requires every review checkbox", () => {
    expect(toRecordableJudgment(reviewForm())).toEqual({
      kind: "review",
      provenanceChecked: true,
      privacyChecked: true,
      scopeChecked: true,
      note: "looked at all of it",
    });
    expect(toRecordableJudgment(reviewForm({ provenanceChecked: false }))).toBeNull();
    expect(toRecordableJudgment(reviewForm({ privacyChecked: false }))).toBeNull();
    expect(toRecordableJudgment(reviewForm({ scopeChecked: false }))).toBeNull();
  });

  it("requires a nonempty bounded note", () => {
    expect(toRecordableJudgment(rightsForm({ note: "   " }))).toBeNull();
    expect(toRecordableJudgment(reviewForm({ note: "" }))).toBeNull();
    expect(toRecordableJudgment(rightsForm({ note: "a".repeat(1001) }))).toBeNull();
    expect(toRecordableJudgment(rightsForm({ note: "a".repeat(1000) }))).not.toBeNull();
  });

  it("bounds the optional rights source and license, empty becomes null", () => {
    expect(toRecordableJudgment(rightsForm({ originalSource: "a".repeat(501) }))).toBeNull();
    expect(toRecordableJudgment(rightsForm({ originalSource: "a".repeat(500) }))).not.toBeNull();
    expect(toRecordableJudgment(rightsForm({ license: "a".repeat(101) }))).toBeNull();
    expect(toRecordableJudgment(rightsForm({ license: " " }))).toEqual({
      kind: "rights",
      basis: "own-work",
      originalSource: null,
      license: null,
      note: "wrote it myself",
    });
  });
});

describe("outcome copy maps", () => {
  it("maps every withdraw status; applied differs from the refresh outcomes", () => {
    expect(withdrawOutcomeCopy.applied.length).toBeGreaterThan(0);
    expect(withdrawOutcomeCopy["already-withdrawn"].length).toBeGreaterThan(0);
    expect(withdrawOutcomeCopy["not-found"].length).toBeGreaterThan(0);
    expect(withdrawOutcomeCopy["already-withdrawn"]).not.toBe(withdrawOutcomeCopy.applied);
    expect(withdrawOutcomeCopy["not-found"]).not.toBe(withdrawOutcomeCopy.applied);
  });

  it("maps the plain delete statuses", () => {
    expect(deleteOutcomeCopy.applied.length).toBeGreaterThan(0);
    expect(deleteOutcomeCopy["not-found"].length).toBeGreaterThan(0);
  });
});

describe("presentation helpers", () => {
  it("summarizes judgments without readiness claims", () => {
    expect(
      judgmentSummary({
        kind: "rights",
        judgmentId: "j1",
        ref: {} as never,
        recordedAt: "2026-10-11T00:00:00.000Z",
        recordedBy: "authenticated-client",
        basis: "own-work",
        originalSource: "docs",
        license: null,
        note: "n",
      } as unknown as ProjectSkillJudgment),
    ).toBe("Basis: Own work · Source: docs");
    expect(
      judgmentSummary({
        kind: "review",
        judgmentId: "j2",
        ref: {} as never,
        recordedAt: "2026-10-11T00:00:00.000Z",
        recordedBy: "authenticated-client",
        provenanceChecked: true,
        privacyChecked: true,
        scopeChecked: true,
        note: "n",
      } as unknown as ProjectSkillJudgment),
    ).toBe("Provenance, privacy, and scope checked");
  });

  it("orders the write-lock copy by what the user can act on", () => {
    expect(resolveSkillWriteLock("pending")).toContain("Checking");
    expect(resolveSkillWriteLock("denied")).toContain("view skill candidates");
    expect(resolveSkillWriteLock("granted")).toBeNull();
  });

  it("prefills the success check from the recorded check names, bounded for long names", () => {
    expect(successCheckPrefill(["lint", "test"])).toBe("Selected checks pass: lint, test");
    const prefill = successCheckPrefill(["a".repeat(1000), "lint", "test"]);
    expect(prefill.length).toBeLessThanOrEqual(PROJECT_SKILL_LIMITS.successCheck);
    expect(prefill.startsWith("Selected checks pass: ")).toBe(true);
    expect(prefill.endsWith("…")).toBe(true);
    // The generated prefill must itself pass the contract validation it feeds.
    expect(toSkillContent({ ...validContent, successCheck: prefill })).not.toBeNull();
  });
});

describe("versionTrialHistoryPanel", () => {
  const trialThreadId = ThreadId.make("thread-1");
  const trialMessageId = MessageId.make("message-9");

  const trialBase = {
    threadId: trialThreadId,
    messageId: trialMessageId,
    inputEventSequence: 120,
    admittedSkillStateSeq: 4,
    delivery: "unknown" as const,
    providerDriverKind: null,
    sameThreadAsSource: false,
  };

  const openTrial: ProjectSkillTrialSummary = {
    ...trialBase,
    window: "open",
    provisionalObservations: [
      {
        attemptId: "attempt-1",
        receiptSequence: 130,
        outcome: "all-selected-passed",
        endedAt: "2026-08-21T00:01:00Z",
      },
    ],
  };

  const openTrialNullEnded: ProjectSkillTrialSummary = {
    ...trialBase,
    window: "open",
    provisionalObservations: [
      {
        attemptId: "attempt-1",
        receiptSequence: 130,
        outcome: "failed",
        endedAt: null,
      },
    ],
  };

  it("stays hidden until the trial capability is advertised", () => {
    expect(projectSkillTrialCapabilityOf(null)).toBe(false);
    expect(versionTrialHistoryPanel({ trialCapability: false, trials: [openTrial] }).kind).toBe(
      "hidden",
    );
  });

  it("treats absent trials as unavailable and an empty list as genuinely empty", () => {
    expect(versionTrialHistoryPanel({ trialCapability: true, trials: undefined }).kind).toBe(
      "unavailable",
    );
    expect(versionTrialHistoryPanel({ trialCapability: true, trials: [] }).kind).toBe("empty");
    expect(versionTrialHistoryPanel({ trialCapability: true, trials: undefined })).toEqual({
      kind: "unavailable",
    });
    expect(versionTrialHistoryPanel({ trialCapability: true, trials: [] })).toEqual({
      kind: "empty",
    });
  });

  it("uses end time unavailable when endedAt is null", () => {
    const row = formatVersionTrialRow(openTrialNullEnded);
    expect(row.lines.some((line) => line.includes("end time unavailable"))).toBe(true);
    expect(row.lines.some((line) => line.includes("still open"))).toBe(false);
  });

  it("formats open, closed, and recreated windows from the version view API", () => {
    const openRow = formatVersionTrialRow(openTrial);
    expect(openRow.lines.some((line) => line.toLowerCase().includes("provisional"))).toBe(true);
    expect(openRow.lines.some((line) => line.includes("may or may not"))).toBe(true);

    const closed: ProjectSkillTrialSummary = {
      ...trialBase,
      delivery: "provider-accepted",
      providerDriverKind: "claude",
      sameThreadAsSource: true,
      window: "closed",
      observations: [
        {
          evidenceId: ProjectSkillEvidenceId.make("evidence-1"),
          attemptId: "attempt-1",
          receiptSequence: 131,
          outcome: "failed",
          endedAt: null,
        },
      ],
      uncountedAttempts: 2,
    };
    const closedRow = formatVersionTrialRow(closed);
    expect(closedRow.lines.some((line) => line.includes("source thread"))).toBe(true);
    expect(closedRow.lines.some((line) => line.includes("Uncounted boundary"))).toBe(true);
    expect(closedRow.lines.some((line) => line.includes("evidence-1"))).toBe(true);

    const recreatedTrial: ProjectSkillTrialSummary = { ...trialBase, window: "thread-recreated" };
    const recreated = formatVersionTrialRow(recreatedTrial);
    expect(recreated.lines.some((line) => line.includes("recreated"))).toBe(true);
    expect(recreated.lines.some((line) => line.includes("Provisional"))).toBe(false);
    expect(recreated.lines.some((line) => line.includes("Observation"))).toBe(false);
  });

  it("maps listed trials through the version view optional key", () => {
    const panel = versionTrialHistoryPanel({ trialCapability: true, trials: [openTrial] });
    expect(panel.kind).toBe("listed");
    if (panel.kind !== "listed") return;
    expect(panel.rows).toHaveLength(1);
    expect(panel.rows[0]!.key).toBe(openTrial.messageId);
    expect(VERSION_TRIAL_HISTORY_UNAVAILABLE_COPY).not.toBe(VERSION_TRIAL_HISTORY_EMPTY_COPY);
  });
});

describe("lifecycle capability and state sequence", () => {
  it("treats absent lifecycle as unsupported without affecting trial", () => {
    expect(projectSkillLifecycleCapabilityOf(null)).toBe(false);
    expect(
      projectSkillLifecycleCapabilityOf({
        environment: { capabilities: { projectSkills: { manage: true, trial: true } } },
      }),
    ).toBe(false);
    expect(
      projectSkillTrialCapabilityOf({
        environment: { capabilities: { projectSkills: { manage: true, trial: true } } },
      }),
    ).toBe(true);
  });

  it("never treats a missing detail stateSeq as zero", () => {
    expect(projectSkillStateSeqOf({ stateSeq: undefined } as never)).toBeNull();
    expect(projectSkillStateSeqOf({ stateSeq: 4 } as never)).toBe(4);
  });
});

describe("use capability", () => {
  it("treats absent or false use as unavailable without affecting lifecycle", () => {
    expect(projectSkillUseCapabilityOf(null)).toBe(false);
    expect(
      projectSkillUseCapabilityOf({
        environment: { capabilities: { projectSkills: { manage: true, lifecycle: true } } },
      }),
    ).toBe(false);
    expect(
      projectSkillUseCapabilityOf({
        environment: {
          capabilities: { projectSkills: { manage: true, lifecycle: true, use: false } },
        },
      }),
    ).toBe(false);
    expect(
      projectSkillLifecycleCapabilityOf({
        environment: {
          capabilities: { projectSkills: { manage: true, lifecycle: true, use: false } },
        },
      }),
    ).toBe(true);
  });

  it("accepts only an explicit true use flag", () => {
    expect(
      projectSkillUseCapabilityOf({
        environment: {
          capabilities: { projectSkills: { manage: true, lifecycle: true, use: true } },
        },
      }),
    ).toBe(true);
    expect(LIFECYCLE_USE_UNAVAILABLE_COPY.length).toBeGreaterThan(0);
  });
});

describe("evidence offers", () => {
  const evidenceId = ProjectSkillEvidenceId.make("evidence-repro");
  const failedEvidence = ProjectSkillEvidenceId.make("evidence-fail");
  const sourceThreadId = ThreadId.make("thread-source");
  const sourceCheck = { threadId: sourceThreadId } as ProjectSkillCheckObservation;
  const trialBaseLocal = {
    threadId: ThreadId.make("thread-trial"),
    messageId: MessageId.make("message-ev"),
    inputEventSequence: 12,
    admittedSkillStateSeq: 1,
    delivery: "provider-accepted" as const,
    providerDriverKind: null,
    sameThreadAsSource: false,
  };
  const makeEvidenceVersionView = (
    trials: ReadonlyArray<ProjectSkillTrialSummary>,
  ): ProjectSkillVersionView => ({
    version: {
      ref: {
        projectId: ProjectId.make("project-evidence"),
        skillId: ProjectSkillId.make("psk_evidence01"),
        version: 1,
        contentSha256: "a".repeat(64),
      },
      content: {
        title: "Evidence fixture",
        purpose: "p",
        appliesWhen: "a",
        doesNotApplyWhen: "n",
        procedure: "proc",
        successCheck: "ok",
      },
      source: {
        type: "work",
        createdAfterEventSequence: 10,
        check: sourceCheck,
        draft: { type: "typed" },
      },
      state: "candidate",
      retiredReason: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    judgments: [],
    rightsRecorded: false,
    reviewRecorded: false,
    trials,
  });
  const view = makeEvidenceVersionView([
    {
      ...trialBaseLocal,
      window: "closed",
      observations: [
        {
          evidenceId,
          attemptId: "attempt-1",
          receiptSequence: 1,
          outcome: "all-selected-passed",
          endedAt: null,
        },
      ],
      uncountedAttempts: 0,
    },
    {
      ...trialBaseLocal,
      sameThreadAsSource: true,
      inputEventSequence: 20,
      window: "closed",
      observations: [
        {
          evidenceId: failedEvidence,
          attemptId: "attempt-2",
          receiptSequence: 2,
          outcome: "failed",
          endedAt: null,
        },
      ],
      uncountedAttempts: 0,
    },
  ]);

  it("filters reproduction evidence by pass, thread, and watermark", () => {
    expect(reproductionEvidenceOffers(view)).toHaveLength(1);
    expect(reproductionEvidenceOffers(view)[0]!.evidenceId).toBe(evidenceId);
    expect(nonApplicationEvidenceOffers(view)).toHaveLength(2);
  });

  it("excludes reproduction when the trial thread equals the source thread", () => {
    const sameThreadEvidence = ProjectSkillEvidenceId.make("evidence-same-thread");
    const withSameThreadTrial = makeEvidenceVersionView([
      ...(view.trials ?? []),
      {
        ...trialBaseLocal,
        threadId: sourceThreadId,
        sameThreadAsSource: false,
        inputEventSequence: 15,
        window: "closed",
        observations: [
          {
            evidenceId: sameThreadEvidence,
            attemptId: "attempt-same-thread",
            receiptSequence: 3,
            outcome: "all-selected-passed",
            endedAt: null,
          },
        ],
        uncountedAttempts: 0,
      },
    ]);
    expect(reproductionEvidenceOffers(withSameThreadTrial)).toHaveLength(1);
    expect(
      findTrialEvidenceOffer(withSameThreadTrial, sameThreadEvidence, "reproduction"),
    ).toBeNull();
  });

  it("re-reads the exact observation after selection", () => {
    expect(findTrialEvidenceOffer(view, evidenceId, "reproduction")).not.toBeNull();
    expect(findTrialEvidenceOffer(view, failedEvidence, "reproduction")).toBeNull();
    expect(findTrialEvidenceOffer(view, failedEvidence, "non-application")).not.toBeNull();
  });
});

describe("lifecycle judgments and rejections", () => {
  it("requires every reproduction acknowledgment", () => {
    expect(
      toRecordableReproduction({
        observedEvidenceId: ProjectSkillEvidenceId.make("ev-1"),
        procedureApplied: true,
        successConditionConfirmed: true,
        taskNotUsedForAuthoring: false,
        note: "n",
      }),
    ).toBeNull();
    expect(
      toRecordableNonApplication({
        observedEvidenceId: ProjectSkillEvidenceId.make("ev-2"),
        taskDescription: "task",
        verdict: "harmful",
        note: "n",
      })?.verdict,
    ).toBe("harmful");
  });

  it("merges derive partials without overwriting touched fields or exclusions", () => {
    const form: SkillContentForm = {
      title: "Kept",
      purpose: "",
      appliesWhen: "",
      doesNotApplyWhen: "",
      procedure: "",
      successCheck: "Selected checks pass: lint",
    };
    const touched = new Set<keyof SkillContentForm>(["title"]);
    const merged = mergeDerivePartialIntoForm(
      form,
      {
        title: "Replaced",
        purpose: "Purpose",
        appliesWhen: "When",
        procedure: "1. Step",
        successCheck: "Check",
      },
      touched,
    );
    expect(merged.title).toBe("Kept");
    expect(merged.purpose).toBe("Purpose");
    expect(merged.doesNotApplyWhen).toBe("");
    expect(merged.successCheck).toBe("Check");
  });

  it("reports truncation fields in derivationTruncationNotice", () => {
    expect(derivationTruncationNotice({ procedure: true })).toContain("procedure");
    expect(derivationTruncationNotice({})).toBeNull();
  });

  it("treats absent generatedDraft capability as unsupported", () => {
    expect(
      projectSkillGeneratedDraftCapabilityOf({
        environment: { capabilities: { projectSkills: {} } },
      }),
    ).toBe(false);
    expect(
      projectSkillGeneratedDraftCapabilityOf({
        environment: { capabilities: { projectSkills: { generatedDraft: true } } },
      }),
    ).toBe(true);
  });

  it("maps all twelve readiness gaps and lifecycle refetch reasons", () => {
    const gaps = Object.keys(READINESS_GAP_COPY) as ProjectSkillReadinessGap[];
    expect(gaps).toHaveLength(12);
    for (const gap of gaps) {
      expect(READINESS_GAP_COPY[gap].length).toBeGreaterThan(0);
    }
    expect(skillLifecycleRejectionNeedsRefetch("state-changed")).toBe(true);
    expect(skillLifecycleRejectionNeedsRefetch("duplicate-content")).toBe(false);
    expect(
      skillRejectionCopy({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "not-ready",
        gaps: ["review-missing"],
      }),
    ).toContain(READINESS_GAP_COPY["review-missing"]);
  });
});
