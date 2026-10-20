import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  PROJECT_SKILL_LIMITS,
  ProjectSkillId,
  ProjectSkillJudgmentId,
  type ProjectSkillCheckObservation,
  type ProjectSkillJudgment,
  type ProjectSkillSource,
  type ProjectSkillVersionRef,
} from "./projectSkill.ts";
import {
  ActivateProjectSkillInput,
  CreateProjectSkillCandidateInput,
  DeleteProjectSkillInput,
  GetProjectSkillInput,
  ListProjectSkillsInput,
  ProjectSkillDeleteResult,
  ProjectSkillDetail,
  ProjectSkillJudgmentRecord,
  ProjectSkillListResult,
  ProjectSkillStoreConflictError,
  ProjectSkillStoreError,
  ProjectSkillStoreNotFoundError,
  ProjectSkillStoreRejectedError,
  ProjectSkillSummary,
  ProjectSkillTransitionResult,
  ProjectSkillTrialSummary,
  ProjectSkillVersionRecord,
  ProjectSkillVersionView,
  ProjectSkillWithdrawResult,
  RecordProjectSkillJudgmentInput,
  RetireProjectSkillInput,
  ReviseProjectSkillInput,
  WithdrawProjectSkillJudgmentInput,
} from "./projectSkillStore.ts";

const projectId = ProjectId.make("project-1");
const skillId = ProjectSkillId.make("psk_abc12345");
const threadId = ThreadId.make("thread-1");
const shaContent = "d".repeat(64);
const shaEnv = "a".repeat(64);
const shaCommand = "b".repeat(64);
const treeOid = "f".repeat(40);

const content = {
  title: "Verify before merge",
  purpose: "keep the tree green",
  appliesWhen: "a change touches shared code",
  doesNotApplyWhen: "docs-only edits",
  procedure: "run the focused tests, then typecheck",
  successCheck: "focused tests and typecheck pass",
};

const checkObservation: ProjectSkillCheckObservation = {
  threadId,
  threadAnchorSequence: 45,
  receiptSequence: 50,
  attemptId: "attempt-1",
  revision: 2,
  projectId,
  workspaceRoot: "/tmp/workspace",
  worktreePath: null,
  cwd: "/tmp/workspace",
  envSha256: shaEnv,
  planned: [{ scriptId: "lint", scriptName: "Lint", commandSha256: shaCommand, timeoutMs: 60_000 }],
  tree: { treeOid, repoTopLevel: "/tmp/workspace", repoCommonDir: "/tmp/workspace" },
  environment: {
    environmentId: EnvironmentId.make("env-1"),
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "24.0.0",
  },
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: "2026-08-20T12:01:00Z",
  outcome: "all-selected-passed",
};

const workSource: ProjectSkillSource = {
  type: "work",
  check: checkObservation,
  createdAfterEventSequence: 20,
  draft: { type: "typed" },
};

const ref: ProjectSkillVersionRef = {
  projectId,
  skillId,
  version: 1,
  contentSha256: shaContent,
};

const rightsJudgment: ProjectSkillJudgment = {
  judgmentId: ProjectSkillJudgmentId.make("judgment-1"),
  ref,
  recordedAt: "2026-08-21T00:00:00Z",
  recordedBy: "authenticated-client",
  note: "reviewed",
  kind: "rights",
  basis: "own-work",
  originalSource: null,
  license: null,
};

const versionRecord: ProjectSkillVersionRecord = {
  ref,
  content,
  source: workSource,
  state: "candidate",
  retiredReason: null,
  createdAt: "2026-08-21T00:00:00Z",
};

const candidateInput = {
  projectId,
  threadId,
  expected: { attemptId: "attempt-1", revision: 2, receiptSequence: 50 },
  content,
  draft: { type: "typed" },
};

describe("CreateProjectSkillCandidateInput", () => {
  const decode = Schema.decodeUnknownExit(CreateProjectSkillCandidateInput);

  it("decodes a typed draft and a message draft", () => {
    expect(Exit.isSuccess(decode(candidateInput))).toBe(true);
    expect(
      Exit.isSuccess(
        decode({ ...candidateInput, draft: { type: "message", messageId: "message-1" } }),
      ),
    ).toBe(true);
  });

  it("rejects unsafe integers and out-of-bounds content", () => {
    for (const expected of [
      { ...candidateInput.expected, receiptSequence: -1 },
      { ...candidateInput.expected, receiptSequence: 2 ** 53 },
      { ...candidateInput.expected, revision: 2 ** 53 },
      { ...candidateInput.expected, attemptId: "x".repeat(65) },
      { ...candidateInput.expected, attemptId: "" },
    ]) {
      expect(Exit.isFailure(decode({ ...candidateInput, expected }))).toBe(true);
    }
    expect(Exit.isFailure(decode({ ...candidateInput, content: { ...content, title: "" } }))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        decode({ ...candidateInput, content: { ...content, procedure: "x".repeat(6001) } }),
      ),
    ).toBe(true);
  });

  it("rejects a message draft without its messageId or an unknown draft type", () => {
    expect(Exit.isFailure(decode({ ...candidateInput, draft: { type: "message" } }))).toBe(true);
    expect(Exit.isFailure(decode({ ...candidateInput, draft: { type: "other" } }))).toBe(true);
  });
});

describe("ReviseProjectSkillInput", () => {
  const decode = Schema.decodeUnknownExit(ReviseProjectSkillInput);
  const input = {
    projectId,
    skillId,
    fromVersion: 1,
    expectedLatestVersion: 1,
    content,
  };

  it("requires positive versions and valid content", () => {
    expect(Exit.isSuccess(decode(input))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, fromVersion: 0 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, expectedLatestVersion: 0 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, expectedLatestVersion: 1.5 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, content: { ...content, title: "" } }))).toBe(true);
  });
});

describe("ListProjectSkillsInput", () => {
  const decode = Schema.decodeUnknownExit(ListProjectSkillsInput);

  it("defaults limit to 50 and bounds it to 1–100", () => {
    const decoded = Schema.decodeUnknownSync(ListProjectSkillsInput)({ projectId });
    expect(decoded.limit).toBe(50);
    expect(Exit.isSuccess(decode({ projectId, limit: 1 }))).toBe(true);
    expect(Exit.isSuccess(decode({ projectId, limit: 100 }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId, limit: 0 }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId, limit: 101 }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId, limit: 1.5 }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId, limit: "50" }))).toBe(true);
  });
});

describe("GetProjectSkillInput", () => {
  const decode = Schema.decodeUnknownExit(GetProjectSkillInput);

  it("binds a projectId and the psk_ skill id", () => {
    expect(Exit.isSuccess(decode({ projectId, skillId }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId, skillId: "not-a-skill" }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId }))).toBe(true);
  });
});

describe("RecordProjectSkillJudgmentInput", () => {
  const decode = Schema.decodeUnknownExit(RecordProjectSkillJudgmentInput);
  const rightsInput = {
    ref,
    judgment: {
      kind: "rights",
      basis: "project-license",
      originalSource: "upstream repo",
      license: "MIT",
      note: "checked",
    },
  };
  const reviewInput = {
    ref,
    judgment: {
      kind: "review",
      provenanceChecked: true,
      privacyChecked: true,
      scopeChecked: true,
      note: "looked",
    },
  };

  it("decodes the rights and review branches", () => {
    expect(Exit.isSuccess(decode(rightsInput))).toBe(true);
    expect(Exit.isSuccess(decode(reviewInput))).toBe(true);
    const decoded = Schema.decodeUnknownSync(RecordProjectSkillJudgmentInput)(rightsInput);
    expect(decoded.judgment).toEqual(rightsInput.judgment);
  });

  it("strips server-authoritative fields a client forges inside the judgment", () => {
    const decoded = Schema.decodeUnknownSync(RecordProjectSkillJudgmentInput)({
      ref,
      judgment: {
        ...reviewInput.judgment,
        judgmentId: "psj_forged",
        ref: { ...ref, version: 99 },
        recordedAt: "1970-01-01T00:00:00Z",
        recordedBy: "root",
      },
    });
    expect(decoded.judgment).toEqual(reviewInput.judgment);
  });

  it("rejects incomplete or unavailable judgment kinds and false review flags", () => {
    for (const kind of [
      "reproduction",
      "non-application",
      "interference",
      "failure-classification",
    ]) {
      expect(Exit.isFailure(decode({ ref, judgment: { ...reviewInput.judgment, kind } }))).toBe(
        true,
      );
    }
    expect(
      Exit.isFailure(
        decode({ ref, judgment: { ...reviewInput.judgment, provenanceChecked: false } }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(decode({ ref, judgment: { ...reviewInput.judgment, note: undefined } })),
    ).toBe(true);
  });

  it("rejects a ref that does not bind all four fields", () => {
    for (const badRef of [
      { ...ref, version: 0 },
      { ...ref, version: -1 },
      { ...ref, version: 1.5 },
      { ...ref, contentSha256: "abc" },
      { ...ref, skillId: "psk_ABC" },
      { skillId, version: 1, contentSha256: shaContent },
    ]) {
      expect(Exit.isFailure(decode({ ref: badRef, judgment: reviewInput.judgment }))).toBe(true);
    }
  });
});

describe("WithdrawProjectSkillJudgmentInput", () => {
  const decode = Schema.decodeUnknownExit(WithdrawProjectSkillJudgmentInput);

  it("requires the exact ref and the judgment id", () => {
    expect(Exit.isSuccess(decode({ ref, judgmentId: "judgment-1" }))).toBe(true);
    expect(Exit.isFailure(decode({ ref }))).toBe(true);
    expect(Exit.isFailure(decode({ ref: { ...ref, version: 0 }, judgmentId: "judgment-1" }))).toBe(
      true,
    );
  });
});

describe("DeleteProjectSkillInput", () => {
  const decode = Schema.decodeUnknownExit(DeleteProjectSkillInput);

  it("requires a positive expectedLatestVersion", () => {
    expect(Exit.isSuccess(decode({ projectId, skillId, expectedLatestVersion: 2 }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId, skillId, expectedLatestVersion: 0 }))).toBe(true);
    expect(Exit.isFailure(decode({ projectId, skillId, expectedLatestVersion: -1 }))).toBe(true);
  });
});

describe("output records", () => {
  it("decodes a work and a revision version record", () => {
    const revisionRecord: ProjectSkillVersionRecord = {
      ...versionRecord,
      ref: { ...ref, version: 2, contentSha256: "e".repeat(64) },
      source: {
        type: "revision",
        fromVersion: 1,
        createdAfterEventSequence: 60,
        root: {
          type: "work",
          check: checkObservation,
          createdAfterEventSequence: 20,
          draft: { type: "message", messageId: MessageId.make("message-9") },
        },
      },
    };
    const decode = Schema.decodeUnknownExit(ProjectSkillVersionRecord);
    expect(Exit.isSuccess(decode(versionRecord))).toBe(true);
    expect(Exit.isSuccess(decode(revisionRecord))).toBe(true);
    expect(Exit.isFailure(decode({ ...versionRecord, state: "held" }))).toBe(true);
    expect(Exit.isFailure(decode({ ...versionRecord, retiredReason: "expired" }))).toBe(true);
  });

  it("bounds the judgment record's watermark to safe ints and permits both withdrawal states", () => {
    const decode = Schema.decodeUnknownExit(ProjectSkillJudgmentRecord);
    const record: ProjectSkillJudgmentRecord = {
      judgment: rightsJudgment,
      recordedAfterEventSequence: 55,
      withdrawnAt: null,
    };
    expect(Exit.isSuccess(decode(record))).toBe(true);
    expect(Exit.isSuccess(decode({ ...record, withdrawnAt: "2026-08-22T00:00:00Z" }))).toBe(true);
    expect(Exit.isFailure(decode({ ...record, recordedAfterEventSequence: -1 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...record, recordedAfterEventSequence: 2 ** 53 }))).toBe(true);
  });

  it("round-trips detail, view, and list results over the JSON wire", () => {
    const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    const view: ProjectSkillVersionView = {
      version: versionRecord,
      judgments: [{ judgment: rightsJudgment, recordedAfterEventSequence: 55, withdrawnAt: null }],
      rightsRecorded: true,
      reviewRecorded: false,
    };
    const detail: ProjectSkillDetail = {
      projectId,
      skillId,
      latestVersion: 1,
      versions: [view],
    };
    expect(Schema.decodeUnknownSync(ProjectSkillDetail)(viaJson(detail))).toEqual(detail);
    expect(Schema.decodeUnknownSync(ProjectSkillVersionView)(viaJson(view))).toEqual(view);
    const summary: ProjectSkillSummary = {
      ref,
      title: content.title,
      state: "candidate",
      createdAt: "2026-08-21T00:00:00Z",
      rightsRecorded: true,
      reviewRecorded: false,
    };
    const list: ProjectSkillListResult = { items: [summary], truncated: false };
    expect(Schema.decodeUnknownSync(ProjectSkillListResult)(viaJson(list))).toEqual(list);
    const decode = Schema.decodeUnknownExit(ProjectSkillListResult);
    expect(Exit.isFailure(decode({ items: [{ ...summary, title: 7 }], truncated: false }))).toBe(
      true,
    );
  });
});

describe("ProjectSkillVersionView trials", () => {
  const decodeView = Schema.decodeUnknownExit(ProjectSkillVersionView);
  const decodeTrial = Schema.decodeUnknownExit(ProjectSkillTrialSummary);
  const view: ProjectSkillVersionView = {
    version: versionRecord,
    judgments: [],
    rightsRecorded: false,
    reviewRecorded: false,
  };

  const trialBase = {
    threadId,
    messageId: "message-9",
    inputEventSequence: 120,
    admittedSkillStateSeq: 4,
    delivery: "unknown",
    providerDriverKind: null,
    sameThreadAsSource: false,
  };

  const openTrial = {
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

  const closedTrial = {
    ...trialBase,
    delivery: "provider-accepted",
    providerDriverKind: "claude",
    window: "closed",
    observations: [
      {
        evidenceId: "evidence-1",
        attemptId: "attempt-1",
        receiptSequence: 131,
        outcome: "failed",
        endedAt: null,
      },
    ],
    uncountedAttempts: 2,
  };

  it("decodes without trials for pre-trial servers and keeps an empty list distinct", () => {
    const without = Schema.decodeUnknownSync(ProjectSkillVersionView)(view);
    expect(without.trials).toBeUndefined();
    const withEmpty = Schema.decodeUnknownSync(ProjectSkillVersionView)({ ...view, trials: [] });
    expect(withEmpty.trials).toEqual([]);
    expect(Exit.isFailure(decodeView({ ...view, trials: null }))).toBe(true);
  });

  it("decodes open windows provisionally, closed windows with evidence, and recreated windows bare", () => {
    expect(Exit.isSuccess(decodeTrial(openTrial))).toBe(true);
    expect(Schema.decodeUnknownSync(ProjectSkillTrialSummary)(openTrial)).toEqual(openTrial);
    expect(Schema.decodeUnknownSync(ProjectSkillTrialSummary)(closedTrial)).toEqual(closedTrial);
    const recreated = { ...trialBase, window: "thread-recreated" };
    expect(Schema.decodeUnknownSync(ProjectSkillTrialSummary)(recreated)).toEqual(recreated);
  });

  it("requires evidence identity on closed observations and never on provisional ones", () => {
    // A closed-window observation without its persisted evidence id cannot decode.
    expect(
      Exit.isFailure(
        decodeTrial({
          ...closedTrial,
          observations: [
            { attemptId: "attempt-1", receiptSequence: 131, outcome: "failed", endedAt: null },
          ],
        }),
      ),
    ).toBe(true);
    // An open window names provisional observations, not the closed shape.
    expect(Exit.isFailure(decodeTrial({ ...trialBase, window: "open", observations: [] }))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        decodeTrial({
          ...trialBase,
          window: "closed",
          provisionalObservations: [],
          uncountedAttempts: 0,
        }),
      ),
    ).toBe(true);
  });

  it("keeps unknown delivery honest and rejects literal drift and unsafe ints", () => {
    // "unknown" decodes; nothing stronger than provider-accepted exists.
    expect(Exit.isSuccess(decodeTrial(openTrial))).toBe(true);
    for (const delivery of ["delivered", "provider-verified", "completed", "sent"]) {
      expect(Exit.isFailure(decodeTrial({ ...openTrial, delivery }))).toBe(true);
    }
    // Only terminal outcomes; a running attempt is not an observation.
    expect(
      Exit.isFailure(
        decodeTrial({
          ...openTrial,
          provisionalObservations: [
            { attemptId: "attempt-1", receiptSequence: 1, outcome: "running", endedAt: null },
          ],
        }),
      ),
    ).toBe(true);
    for (const patch of [
      { inputEventSequence: -1 },
      { inputEventSequence: 2 ** 53 },
      { admittedSkillStateSeq: 1.5 },
      { window: "half-open" },
    ]) {
      expect(Exit.isFailure(decodeTrial({ ...openTrial, ...patch }))).toBe(true);
    }
    expect(Exit.isFailure(decodeTrial({ ...closedTrial, uncountedAttempts: -1 }))).toBe(true);
    expect(Exit.isFailure(decodeTrial({ ...trialBase, window: "closed", observations: [] }))).toBe(
      true,
    );
  });

  it("carries trials inside the version view over the JSON wire", () => {
    const viaJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
    const decoded = Schema.decodeUnknownSync(ProjectSkillVersionView)(
      viaJson({ ...view, trials: [openTrial, closedTrial] }),
    );
    expect(decoded).toEqual({ ...view, trials: [openTrial, closedTrial] });
  });
});

describe("outcome results", () => {
  const decodeWithdraw = Schema.decodeUnknownExit(ProjectSkillWithdrawResult);
  const decodeDelete = Schema.decodeUnknownExit(ProjectSkillDeleteResult);

  it("decodes every withdraw status and rejects unknown ones", () => {
    for (const status of ["applied", "not-found", "already-withdrawn"]) {
      expect(Exit.isSuccess(decodeWithdraw({ status }))).toBe(true);
    }
    expect(Exit.isFailure(decodeWithdraw({ status: "conflict" }))).toBe(true);
    expect(Exit.isFailure(decodeWithdraw({}))).toBe(true);
  });

  it("decodes delete's field-free statuses and the conflict branch's live version", () => {
    for (const status of ["applied", "not-found"]) {
      expect(Exit.isSuccess(decodeDelete({ status }))).toBe(true);
    }
    const decoded = Schema.decodeUnknownSync(ProjectSkillDeleteResult)({
      status: "conflict",
      currentLatestVersion: 2,
    });
    expect(decoded).toEqual({ status: "conflict", currentLatestVersion: 2 });
    expect(Exit.isFailure(decodeDelete({ status: "conflict" }))).toBe(true);
    expect(Exit.isFailure(decodeDelete({ status: "conflict", currentLatestVersion: 0 }))).toBe(
      true,
    );
    expect(Exit.isFailure(decodeDelete({ status: "already-withdrawn" }))).toBe(true);
  });
});

describe("store errors", () => {
  it("decodes a rejected error with only its fixed reason fields", () => {
    const rejected = Schema.decodeUnknownSync(ProjectSkillStoreRejectedError)({
      _tag: "ProjectSkillStoreRejectedError",
      reason: "screen",
      screenReasons: ["sensitive"],
    });
    expect(rejected).toBeInstanceOf(ProjectSkillStoreRejectedError);
    expect(rejected.reason).toBe("screen");
    expect(rejected.screenReasons).toEqual(["sensitive"]);
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(ProjectSkillStoreRejectedError)({
          _tag: "ProjectSkillStoreRejectedError",
          reason: "source-ineligible",
          sourceReason: "worktree-changed",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(ProjectSkillStoreRejectedError)({
          _tag: "ProjectSkillStoreRejectedError",
          reason: "rate-limited",
        }),
      ),
    ).toBe(true);
  });

  it("constructs conflict, not-found, and store errors with their tags", () => {
    const conflict = new ProjectSkillStoreConflictError({ currentLatestVersion: 3 });
    expect(conflict._tag).toBe("ProjectSkillStoreConflictError");
    expect(conflict.currentLatestVersion).toBe(3);
    const notFound = new ProjectSkillStoreNotFoundError({});
    expect(notFound._tag).toBe("ProjectSkillStoreNotFoundError");
    const store = new ProjectSkillStoreError({ message: "project-skill store operation failed" });
    expect(store._tag).toBe("ProjectSkillStoreError");
    expect(store.message).toBe("project-skill store operation failed");
  });
});

describe("ActivateProjectSkillInput", () => {
  const decode = Schema.decodeUnknownExit(ActivateProjectSkillInput);
  const input = {
    ref,
    expectedStateSeq: 3,
    target: { threadId, scriptIds: ["lint"] },
  };

  it("decodes a valid activation; restore reuses the same request shape", () => {
    expect(Exit.isSuccess(decode(input))).toBe(true);
    expect(
      Exit.isSuccess(
        decode({ ...input, ref: { ...ref, version: 2, contentSha256: "e".repeat(64) } }),
      ),
    ).toBe(true);
    expect(Exit.isSuccess(decode({ ...input, expectedStateSeq: 0 }))).toBe(true);
  });

  it("rejects a ref that does not bind all four fields", () => {
    for (const badRef of [
      { ...ref, version: 0 },
      { ...ref, version: 1.5 },
      { ...ref, contentSha256: "abc" },
      { skillId, version: 1, contentSha256: shaContent },
    ]) {
      expect(Exit.isFailure(decode({ ...input, ref: badRef }))).toBe(true);
    }
  });

  it("requires a present, safe, nonnegative integer expectedStateSeq", () => {
    for (const expectedStateSeq of [undefined, null, -1, 1.5, 2 ** 53, "3"]) {
      expect(Exit.isFailure(decode({ ...input, expectedStateSeq }))).toBe(true);
    }
  });

  it("requires a target thread and at least one nonblank script id", () => {
    expect(Exit.isFailure(decode({ ...input, target: { threadId, scriptIds: [] } }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, target: { threadId, scriptIds: [""] } }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, target: { threadId, scriptIds: ["  "] } }))).toBe(
      true,
    );
    expect(Exit.isFailure(decode({ ...input, target: { threadId } }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, target: { scriptIds: ["lint"] } }))).toBe(true);
    expect(Exit.isFailure(decode({ ...input, target: undefined }))).toBe(true);
  });
});

describe("RetireProjectSkillInput", () => {
  const decode = Schema.decodeUnknownExit(RetireProjectSkillInput);
  const input = { ref, expectedStateSeq: 4 };

  it("decodes a valid retirement", () => {
    expect(Exit.isSuccess(decode(input))).toBe(true);
    expect(Exit.isSuccess(decode({ ...input, expectedStateSeq: 0 }))).toBe(true);
  });

  it("requires the exact ref and a present, safe, nonnegative sequence", () => {
    expect(Exit.isFailure(decode({ ref }))).toBe(true);
    for (const expectedStateSeq of [undefined, null, -1, 1.5, 2 ** 53]) {
      expect(Exit.isFailure(decode({ ...input, expectedStateSeq }))).toBe(true);
    }
    expect(Exit.isFailure(decode({ ...input, ref: { ...ref, version: 0 } }))).toBe(true);
  });
});

describe("ProjectSkillTransitionResult", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillTransitionResult);

  it("carries exactly the new state sequence", () => {
    expect(Schema.decodeUnknownSync(ProjectSkillTransitionResult)({ stateSeq: 7 })).toEqual({
      stateSeq: 7,
    });
    expect(Exit.isSuccess(decode({ stateSeq: 0 }))).toBe(true);
    for (const stateSeq of [undefined, null, -1, 1.5, 2 ** 53, "7"]) {
      expect(Exit.isFailure(decode({ stateSeq }))).toBe(true);
    }
    expect(Exit.isFailure(decode({}))).toBe(true);
  });
});

describe("ProjectSkillDetail stateSeq", () => {
  const decodeDetail = Schema.decodeUnknownExit(ProjectSkillDetail);
  const detailBase = {
    projectId,
    skillId,
    latestVersion: 1,
    versions: [],
  };

  it("keeps an absent stateSeq unknown, retains zero, and rejects null or unsafe values", () => {
    expect(Schema.decodeUnknownSync(ProjectSkillDetail)(detailBase).stateSeq).toBeUndefined();
    expect(Schema.decodeUnknownSync(ProjectSkillDetail)({ ...detailBase, stateSeq: 0 })).toEqual({
      ...detailBase,
      stateSeq: 0,
    });
    expect(Exit.isSuccess(decodeDetail({ ...detailBase, stateSeq: 2 ** 53 - 1 }))).toBe(true);
    for (const stateSeq of [null, -1, 1.5, 2 ** 53]) {
      expect(Exit.isFailure(decodeDetail({ ...detailBase, stateSeq }))).toBe(true);
    }
  });
});

describe("RecordProjectSkillJudgmentInput reproduction judgments", () => {
  const decode = Schema.decodeUnknownExit(RecordProjectSkillJudgmentInput);
  const reproductionInput = {
    ref,
    judgment: {
      kind: "reproduction",
      observedEvidenceId: "evidence-1",
      procedureApplied: true,
      successConditionConfirmed: true,
      taskNotUsedForAuthoring: true,
      note: "ran the procedure on a separate task",
    },
  };

  it("decodes a complete reproduction claim", () => {
    expect(Exit.isSuccess(decode(reproductionInput))).toBe(true);
    expect(Schema.decodeUnknownSync(RecordProjectSkillJudgmentInput)(reproductionInput)).toEqual(
      reproductionInput,
    );
  });

  it("requires every mandatory flag to be exactly true", () => {
    for (const flag of [
      "procedureApplied",
      "successConditionConfirmed",
      "taskNotUsedForAuthoring",
    ] as const) {
      expect(
        Exit.isFailure(decode({ ref, judgment: { ...reproductionInput.judgment, [flag]: false } })),
      ).toBe(true);
      expect(
        Exit.isFailure(
          decode({ ref, judgment: { ...reproductionInput.judgment, [flag]: undefined } }),
        ),
      ).toBe(true);
    }
  });

  it("requires a valid evidence id and a bounded note", () => {
    for (const observedEvidenceId of ["", "  ", undefined]) {
      expect(
        Exit.isFailure(
          decode({ ref, judgment: { ...reproductionInput.judgment, observedEvidenceId } }),
        ),
      ).toBe(true);
    }
    expect(
      Exit.isFailure(
        decode({
          ref,
          judgment: {
            ...reproductionInput.judgment,
            note: "x".repeat(PROJECT_SKILL_LIMITS.note + 1),
          },
        }),
      ),
    ).toBe(true);
  });

  it("strips server-owned identity fields a client forges", () => {
    const decoded = Schema.decodeUnknownSync(RecordProjectSkillJudgmentInput)({
      ref,
      judgment: {
        ...reproductionInput.judgment,
        judgmentId: "psj_forged",
        ref: { ...ref, version: 99 },
        recordedAt: "1970-01-01T00:00:00Z",
        recordedBy: "root",
      },
    });
    expect(decoded.judgment).toEqual(reproductionInput.judgment);
  });
});

describe("RecordProjectSkillJudgmentInput non-application judgments", () => {
  const decode = Schema.decodeUnknownExit(RecordProjectSkillJudgmentInput);
  const nonApplicationInput = {
    ref,
    judgment: {
      kind: "non-application",
      observedEvidenceId: "evidence-2",
      taskDescription: "rename the dev database",
      verdict: "correctly-not-applied",
      note: "procedure targets test runs only",
    },
  };

  it("decodes both verdicts", () => {
    expect(Exit.isSuccess(decode(nonApplicationInput))).toBe(true);
    expect(
      Exit.isSuccess(
        decode({ ref, judgment: { ...nonApplicationInput.judgment, verdict: "harmful" } }),
      ),
    ).toBe(true);
  });

  it("rejects other verdicts and blank task descriptions", () => {
    expect(
      Exit.isFailure(
        decode({ ref, judgment: { ...nonApplicationInput.judgment, verdict: "fine" } }),
      ),
    ).toBe(true);
    for (const taskDescription of ["", "  ", undefined]) {
      expect(
        Exit.isFailure(
          decode({ ref, judgment: { ...nonApplicationInput.judgment, taskDescription } }),
        ),
      ).toBe(true);
    }
    expect(
      Exit.isFailure(
        decode({ ref, judgment: { ...nonApplicationInput.judgment, note: undefined } }),
      ),
    ).toBe(true);
  });
});

describe("lifecycle reject reasons and readiness gaps", () => {
  const decodeRejected = Schema.decodeUnknownExit(ProjectSkillStoreRejectedError);

  it("accepts the new lifecycle reasons as fixed reject values", () => {
    for (const reason of [
      "not-ready",
      "state-changed",
      "state-invalid",
      "evidence-mismatch",
      "target-unconfirmed",
    ]) {
      expect(
        Exit.isSuccess(decodeRejected({ _tag: "ProjectSkillStoreRejectedError", reason })),
      ).toBe(true);
    }
    expect(
      Exit.isFailure(
        decodeRejected({ _tag: "ProjectSkillStoreRejectedError", reason: "state-stale" }),
      ),
    ).toBe(true);
  });

  it("carries validated readiness gaps or keeps them absent", () => {
    const rejected = Schema.decodeUnknownSync(ProjectSkillStoreRejectedError)({
      _tag: "ProjectSkillStoreRejectedError",
      reason: "not-ready",
      gaps: ["review-missing", "reproduction-missing"],
    });
    expect(rejected.gaps).toEqual(["review-missing", "reproduction-missing"]);
    expect(
      Schema.decodeUnknownSync(ProjectSkillStoreRejectedError)({
        _tag: "ProjectSkillStoreRejectedError",
        reason: "not-ready",
      }).gaps,
    ).toBeUndefined();
    expect(
      Exit.isFailure(
        decodeRejected({
          _tag: "ProjectSkillStoreRejectedError",
          reason: "not-ready",
          gaps: ["made-up-gap"],
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decodeRejected({ _tag: "ProjectSkillStoreRejectedError", reason: "not-ready", gaps: null }),
      ),
    ).toBe(true);
  });
});
