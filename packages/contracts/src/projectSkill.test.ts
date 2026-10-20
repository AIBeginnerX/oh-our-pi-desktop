import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";
import {
  PROJECT_SKILL_CONTEXT_KIND,
  PROJECT_SKILL_LIMITS,
  ProjectSkillCheckObservation,
  ProjectSkillContent,
  ProjectSkillContextPayload,
  ProjectSkillEnvironment,
  ProjectSkillEvidenceId,
  ProjectSkillHold,
  ProjectSkillHoldId,
  ProjectSkillId,
  ProjectSkillInputObservation,
  ProjectSkillJudgment,
  ProjectSkillJudgmentId,
  ProjectSkillManagedSendEvidence,
  ProjectSkillVersionRef,
  canonicalProjectSkillContentJson,
  deriveProjectSkillReadiness,
  isProjectSkillHoldReleased,
  projectSkillEnvironmentMismatch,
  projectSkillEnvironmentOf,
  renderProjectSkillBlock,
  type ProjectSkillObservedUse,
  type ProjectSkillReadinessGap,
  type ProjectSkillSource,
  type ProjectSkillTarget,
} from "./projectSkill.ts";
import { SELECTED_CHECK_MAX } from "./selectedChecks.ts";

const sha = (char: string) => char.repeat(64);
const shaEnv = sha("a");
const shaCommand = sha("b");
const shaInventory = sha("c");
const shaContent = sha("d");
const shaOther = sha("e");
const shaRoute = sha("1");
const shaBlock = sha("2");
const treeOid = "f".repeat(40);

const projectId = ProjectId.make("project-1");
const otherProjectId = ProjectId.make("project-2");
const skillId = ProjectSkillId.make("psk_abc12345");
const sourceThreadId = ThreadId.make("thread-source");
const reproductionThreadId = ThreadId.make("thread-reproduction");
const otherThreadId = ThreadId.make("thread-other");
const environmentId = EnvironmentId.make("env-1");

const evidenceReproduction = ProjectSkillEvidenceId.make("evidence-reproduction");
const evidenceReproductionAlt = ProjectSkillEvidenceId.make("evidence-reproduction-alt");
const evidenceCodex = ProjectSkillEvidenceId.make("evidence-codex");
const evidenceNonApplication = ProjectSkillEvidenceId.make("evidence-non-application");
const evidenceInterference = ProjectSkillEvidenceId.make("evidence-interference");

const ref: ProjectSkillVersionRef = {
  projectId,
  skillId,
  version: 1,
  contentSha256: shaContent,
};

const content: ProjectSkillContent = {
  title: "Verify before merge",
  purpose: "keep the tree green",
  appliesWhen: "a change touches shared code",
  doesNotApplyWhen: "docs-only edits",
  procedure: "run the focused tests, then typecheck",
  successCheck: "focused tests and typecheck pass",
};

// Check sequences follow the effective input sequence: a use input at 40 sees
// its attempt first write at 45 and final receipt at 50, as Lane B's use
// window requires.
const checkObservation = (
  overrides: Partial<ProjectSkillCheckObservation> = {},
): ProjectSkillCheckObservation => ({
  threadId: reproductionThreadId,
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
    environmentId,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "24.0.0",
  },
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: "2026-08-20T12:01:00Z",
  outcome: "all-selected-passed",
  ...overrides,
});

// The source check ran before the version was created: first write 5, final
// receipt 10, creation watermark 20.
const workSource = (): Extract<ProjectSkillSource, { type: "work" }> => ({
  type: "work",
  check: checkObservation({
    threadId: sourceThreadId,
    threadAnchorSequence: 5,
    receiptSequence: 10,
  }),
  createdAfterEventSequence: 20,
  draft: { type: "typed" },
});

const inputObservation = (
  overrides: Partial<ProjectSkillInputObservation> = {},
): ProjectSkillInputObservation => ({
  threadId: reproductionThreadId,
  projectId,
  messageId: MessageId.make("message-1"),
  inputEventSequence: 40,
  admittedSkillStateSeq: 7,
  providerDriverKind: "claude",
  nativeSkillInventorySha256: shaInventory,
  items: [{ ref, mode: "use" }],
  ...overrides,
});

const passedUse = (
  evidenceId: ProjectSkillEvidenceId,
  overrides: {
    input?: Partial<ProjectSkillInputObservation>;
    check?: Partial<ProjectSkillCheckObservation>;
  } = {},
): ProjectSkillObservedUse => {
  const input = inputObservation(overrides.input);
  return {
    evidenceId,
    input,
    check: checkObservation({
      threadAnchorSequence: input.inputEventSequence + 5,
      receiptSequence: input.inputEventSequence + 10,
      ...overrides.check,
    }),
  };
};

const currentEnvironment = (
  overrides: Partial<ProjectSkillEnvironment> = {},
): ProjectSkillEnvironment => ({
  platform: "darwin",
  arch: "arm64",
  envSha256: shaEnv,
  checkCommands: [{ scriptId: "lint", commandSha256: shaCommand }],
  providerDriverKind: "claude",
  nativeSkillInventorySha256: shaInventory,
  ...overrides,
});

const managedSendEvidence = (
  overrides: Partial<ProjectSkillManagedSendEvidence> = {},
): ProjectSkillManagedSendEvidence => ({
  scope: "managed-procedure/v1",
  deliveredRef: ref,
  deliveredBlockSha256: shaBlock,
  providerInstanceId: "instance-1",
  providerSessionId: "session-1",
  routeConfigSha256: shaRoute,
  ...overrides,
});

const managedEnvironment = (
  overrides: Partial<ProjectSkillEnvironment> = {},
): ProjectSkillEnvironment => ({
  ...currentEnvironment(),
  nativeSkillInventorySha256: null,
  scope: "managed-procedure/v1",
  routeConfigSha256: shaRoute,
  ...overrides,
});

const managedPassedUse = (
  evidenceId: ProjectSkillEvidenceId,
  overrides: {
    input?: Partial<ProjectSkillInputObservation>;
    check?: Partial<ProjectSkillCheckObservation>;
  } = {},
): ProjectSkillObservedUse =>
  passedUse(evidenceId, {
    input: {
      nativeSkillInventorySha256: null,
      managedSend: managedSendEvidence(),
      ...overrides.input,
    },
    ...(overrides.check === undefined ? {} : { check: overrides.check }),
  });

let judgmentCounter = 0;
const judgmentBase = () => ({
  judgmentId: ProjectSkillJudgmentId.make(`judgment-${(judgmentCounter += 1)}`),
  ref,
  recordedAt: "2026-08-21T00:00:00Z",
  recordedBy: "authenticated-client" as const,
  note: "reviewed",
});

const rightsJudgment = (): ProjectSkillJudgment => ({
  ...judgmentBase(),
  kind: "rights",
  basis: "own-work",
  originalSource: null,
  license: null,
});

const reviewJudgment = (): ProjectSkillJudgment => ({
  ...judgmentBase(),
  kind: "review",
  provenanceChecked: true,
  privacyChecked: true,
  scopeChecked: true,
});

const reproductionJudgment = (evidenceId: ProjectSkillEvidenceId): ProjectSkillJudgment => ({
  ...judgmentBase(),
  kind: "reproduction",
  observedEvidenceId: evidenceId,
  procedureApplied: true,
  successConditionConfirmed: true,
  taskNotUsedForAuthoring: true,
});

const nonApplicationJudgment = (
  evidenceId: ProjectSkillEvidenceId,
  verdict: "correctly-not-applied" | "harmful" = "correctly-not-applied",
): ProjectSkillJudgment => ({
  ...judgmentBase(),
  kind: "non-application",
  observedEvidenceId: evidenceId,
  taskDescription: "an unrelated refactor request",
  verdict,
});

const interferenceJudgment = (
  evidenceId: ProjectSkillEvidenceId,
  coActive: ReadonlyArray<ProjectSkillVersionRef>,
  verdict: "no-interference-observed" | "interference" = "no-interference-observed",
): ProjectSkillJudgment => ({
  ...judgmentBase(),
  kind: "interference",
  observedEvidenceId: evidenceId,
  coActive: [...coActive],
  verdict,
});

const failureClassificationJudgment = (
  holdId: ProjectSkillHoldId,
  classification: "unrelated" | "skill-caused",
): ProjectSkillJudgment => ({
  ...judgmentBase(),
  kind: "failure-classification",
  holdId,
  classification,
});

const readyTarget = (overrides: Partial<ProjectSkillTarget> = {}): ProjectSkillTarget => ({
  ref,
  state: "candidate",
  retiredReason: null,
  source: workSource(),
  ...overrides,
});

const nonApplicationUse = (): ProjectSkillObservedUse => ({
  evidenceId: evidenceNonApplication,
  input: inputObservation(),
  check: null,
});

const readyObservedUses = (): ReadonlyArray<ProjectSkillObservedUse> => [
  passedUse(evidenceReproduction),
  nonApplicationUse(),
];

const readyJudgments = (): ReadonlyArray<ProjectSkillJudgment> => [
  rightsJudgment(),
  reviewJudgment(),
  reproductionJudgment(evidenceReproduction),
  nonApplicationJudgment(evidenceNonApplication),
];

const derive = (overrides: Partial<Parameters<typeof deriveProjectSkillReadiness>[0]> = {}) =>
  deriveProjectSkillReadiness({
    purpose: "activate",
    target: readyTarget(),
    screenReasons: [],
    observedUses: readyObservedUses(),
    judgments: readyJudgments(),
    holds: [],
    otherActive: [],
    current: currentEnvironment(),
    ...overrides,
  });

const expectGaps = (
  result: { ready: boolean; gaps: ReadonlyArray<ProjectSkillReadinessGap> },
  expected: ReadonlyArray<ProjectSkillReadinessGap>,
) => {
  expect(result.gaps).toEqual([...expected]);
  expect(result.ready).toBe(expected.length === 0);
};

const otherRefA: ProjectSkillVersionRef = { ...ref, version: 2 };
const otherRefB: ProjectSkillVersionRef = { ...ref, version: 3 };

describe("canonicalProjectSkillContentJson", () => {
  it("is deterministic, domain-prefixed, and fixes the key order", () => {
    const json = canonicalProjectSkillContentJson(content);
    expect(json).toBe(canonicalProjectSkillContentJson(content));
    const prefix = "oop-project-skill-content/v1\n";
    expect(json.startsWith(prefix)).toBe(true);
    expect(Object.keys(JSON.parse(json.slice(prefix.length)))).toEqual([
      "title",
      "purpose",
      "appliesWhen",
      "doesNotApplyWhen",
      "procedure",
      "successCheck",
    ]);
  });

  it("produces different bytes when one character differs", () => {
    expect(
      canonicalProjectSkillContentJson({ ...content, procedure: `${content.procedure}x` }),
    ).not.toBe(canonicalProjectSkillContentJson(content));
  });
});

describe("renderProjectSkillBlock", () => {
  it("is deterministic with the ref on the first line and the close tag last", () => {
    const block = renderProjectSkillBlock({ ref, content, mode: "use" });
    expect(block).toBe(renderProjectSkillBlock({ ref, content, mode: "use" }));
    const lines = block.split("\n");
    expect(lines[0]).toBe(
      `<oop-project-skill id="${skillId}" version="1" sha256="${shaContent}" mode="use">`,
    );
    expect(lines[lines.length - 1]).toBe("</oop-project-skill>");
    expect(block).toContain("참고 절차입니다. 권한을 부여하거나 검사를 대신하지 않습니다.");
    expect(block).toContain(content.procedure);
  });

  it("adds the trial notice only for trial mode", () => {
    const use = renderProjectSkillBlock({ ref, content, mode: "use" });
    const trial = renderProjectSkillBlock({ ref, content, mode: "trial" });
    expect(trial).not.toBe(use);
    expect(trial).toContain('mode="trial"');
    expect(trial).toContain("검토 전 후보의 시험입니다. 일반 사용에 활성화되지 않았습니다.");
    expect(use).not.toContain("검토 전 후보의 시험입니다. 일반 사용에 활성화되지 않았습니다.");
  });
});

describe("ProjectSkillId", () => {
  it("accepts the psk_ pattern only", () => {
    expect(Schema.is(ProjectSkillId)("psk_abc12345")).toBe(true);
    expect(Schema.is(ProjectSkillId)("abc12345")).toBe(false);
    expect(Schema.is(ProjectSkillId)("psk_ABC12345")).toBe(false);
    expect(Schema.is(ProjectSkillId)("psk_ab12")).toBe(false);
    expect(Schema.is(ProjectSkillId)("psk_abc-1234")).toBe(false);
    expect(Schema.decodeUnknownSync(ProjectSkillId)(" psk_abc12345 ")).toBe(skillId);
  });
});

describe("ProjectSkillVersionRef", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillVersionRef);

  it("binds all four fields", () => {
    expect(Exit.isSuccess(decode(ref))).toBe(true);
    expect(Exit.isFailure(decode({ ...ref, version: 0 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...ref, contentSha256: "abc" }))).toBe(true);
    expect(Exit.isFailure(decode({ ...ref, skillId: "not-a-skill" }))).toBe(true);
  });
});

describe("ProjectSkillContent", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillContent);

  it("enforces trimmed non-empty per-field limits", () => {
    expect(Exit.isSuccess(decode(content))).toBe(true);
    expect(
      Exit.isFailure(decode({ ...content, title: "x".repeat(PROJECT_SKILL_LIMITS.title + 1) })),
    ).toBe(true);
    expect(
      Exit.isFailure(
        decode({ ...content, procedure: "x".repeat(PROJECT_SKILL_LIMITS.procedure + 1) }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decode({ ...content, purpose: "   " }))).toBe(true);
    expect(Exit.isFailure(decode({ ...content, title: "" }))).toBe(true);
  });
});

describe("ProjectSkillCheckObservation", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillCheckObservation);

  it("requires a proven tree and end only for the passed outcome", () => {
    expect(Exit.isSuccess(decode(checkObservation()))).toBe(true);
    expect(Exit.isFailure(decode({ ...checkObservation(), tree: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...checkObservation(), endedAt: null }))).toBe(true);
    expect(
      Exit.isSuccess(
        decode({ ...checkObservation(), outcome: "failed", tree: null, endedAt: null }),
      ),
    ).toBe(true);
  });

  it("rejects a missing anchor or an unsafe sequence", () => {
    expect(Exit.isFailure(decode({ ...checkObservation(), threadAnchorSequence: null }))).toBe(
      true,
    );
    expect(Exit.isFailure(decode({ ...checkObservation(), receiptSequence: -1 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...checkObservation(), revision: 2 ** 53 }))).toBe(true);
  });
});

describe("ProjectSkillJudgment", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillJudgment);

  it("decodes every kind bound to a full ref", () => {
    for (const judgment of [
      rightsJudgment(),
      reviewJudgment(),
      reproductionJudgment(evidenceReproduction),
      nonApplicationJudgment(evidenceNonApplication),
      interferenceJudgment(evidenceInterference, [ref]),
      failureClassificationJudgment(ProjectSkillHoldId.make("hold-1"), "unrelated"),
    ]) {
      expect(Exit.isSuccess(decode(judgment))).toBe(true);
    }
  });

  it("fails closed when a required Literal(true) is recorded as false", () => {
    expect(Exit.isFailure(decode({ ...reviewJudgment(), provenanceChecked: false }))).toBe(true);
    expect(Exit.isFailure(decode({ ...reviewJudgment(), privacyChecked: false }))).toBe(true);
    expect(Exit.isFailure(decode({ ...reviewJudgment(), scopeChecked: false }))).toBe(true);
    const reproduction = reproductionJudgment(evidenceReproduction);
    for (const field of [
      "procedureApplied",
      "successConditionConfirmed",
      "taskNotUsedForAuthoring",
    ] as const) {
      expect(Exit.isFailure(decode({ ...reproduction, [field]: false }))).toBe(true);
    }
  });

  it("rejects an interference judgment with an empty coActive", () => {
    expect(
      Exit.isFailure(
        decode({ ...interferenceJudgment(evidenceInterference, [ref]), coActive: [] }),
      ),
    ).toBe(true);
  });
});

describe("ProjectSkillContextPayload", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillContextPayload);
  const decodeSync = Schema.decodeUnknownSync(ProjectSkillContextPayload);
  const encode = Schema.encodeUnknownSync(ProjectSkillContextPayload);
  const scriptIds = (count: number) =>
    Array.from({ length: count }, (_, index) => `check-${index}`);

  it("decodes with or without the server-stamped admission sequence", () => {
    expect(PROJECT_SKILL_CONTEXT_KIND).toBe("project-skill");
    expect(Exit.isSuccess(decode({ ref, mode: "use" }))).toBe(true);
    expect(Exit.isSuccess(decode({ ref, mode: "trial", admittedSkillStateSeq: 3 }))).toBe(true);
    expect(Exit.isFailure(decode({ ref, mode: "use", admittedSkillStateSeq: -1 }))).toBe(true);
  });

  it("encode/decode roundtrip retains selectedScriptIds order", () => {
    const selectedScriptIds = ["beta", "alpha", "gamma"];
    const input = { ref, mode: "trial" as const, selectedScriptIds };
    const roundtrip = decodeSync(encode(input));
    expect(roundtrip.selectedScriptIds).toEqual(selectedScriptIds);
    expect(roundtrip).toEqual(input);
  });

  it("keeps selectedScriptIds absent on older trial payloads", () => {
    const decoded = decodeSync({ ref, mode: "trial" });
    expect(decoded.selectedScriptIds).toBeUndefined();
  });

  it("rejects invalid selectedScriptIds", () => {
    const base = { ref, mode: "trial" as const };
    for (const selectedScriptIds of [
      null,
      "lint",
      [],
      [""],
      ["   "],
      [123],
      ["lint", "lint"],
      ["lint", " lint"],
      scriptIds(SELECTED_CHECK_MAX + 1),
    ]) {
      expect(Exit.isFailure(decode({ ...base, selectedScriptIds }))).toBe(true);
    }
  });

  it("accepts selectedScriptIds up to SELECTED_CHECK_MAX unique ids", () => {
    const base = { ref, mode: "trial" as const };
    expect(Exit.isSuccess(decode({ ...base, selectedScriptIds: ["lint"] }))).toBe(true);
    expect(
      Exit.isSuccess(decode({ ...base, selectedScriptIds: scriptIds(SELECTED_CHECK_MAX) })),
    ).toBe(true);
  });
});

describe("ProjectSkillManagedSendEvidence", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillManagedSendEvidence);

  it("requires the managed scope, a full ref, and non-empty send bindings", () => {
    expect(Exit.isSuccess(decode(managedSendEvidence()))).toBe(true);
    for (const evidence of [
      null,
      { ...managedSendEvidence(), scope: "native-inventory" },
      { ...managedSendEvidence(), scope: "managed-procedure/v2" },
      { ...managedSendEvidence(), scope: undefined },
      { ...managedSendEvidence(), deliveredRef: { ...ref, version: 0 } },
      { ...managedSendEvidence(), deliveredBlockSha256: "abc" },
      { ...managedSendEvidence(), providerInstanceId: "   " },
      { ...managedSendEvidence(), providerSessionId: "" },
      { ...managedSendEvidence(), routeConfigSha256: null },
      { ...managedSendEvidence(), routeConfigSha256: undefined },
    ]) {
      expect(Exit.isFailure(decode(evidence))).toBe(true);
    }
  });
});

describe("ProjectSkillInputObservation managed branch", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillInputObservation);
  const managedInput = () =>
    inputObservation({ nativeSkillInventorySha256: null, managedSend: managedSendEvidence() });

  it("keeps the legacy shape and a consistent managed use decodable", () => {
    expect(Exit.isSuccess(decode(inputObservation()))).toBe(true);
    expect(Exit.isSuccess(decode(managedInput()))).toBe(true);
  });

  it("rejects managed branches with confirmed inventory or an unconfirmed driver", () => {
    expect(
      Exit.isFailure(decode({ ...managedInput(), nativeSkillInventorySha256: shaInventory })),
    ).toBe(true);
    expect(Exit.isFailure(decode({ ...managedInput(), providerDriverKind: null }))).toBe(true);
  });

  it("rejects managed evidence whose deliveredRef is not among the input items", () => {
    expect(
      Exit.isFailure(
        decode({
          ...managedInput(),
          managedSend: managedSendEvidence({ deliveredRef: otherRefA }),
        }),
      ),
    ).toBe(true);
  });
});

describe("ProjectSkillEnvironment evidence scope", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillEnvironment);

  it("accepts the legacy shape, an explicit native scope, and a managed environment", () => {
    expect(Exit.isSuccess(decode(currentEnvironment()))).toBe(true);
    expect(Exit.isSuccess(decode(currentEnvironment({ scope: "native-inventory" })))).toBe(true);
    expect(Exit.isSuccess(decode(managedEnvironment()))).toBe(true);
  });

  it("rejects scope-inconsistent environments as a group", () => {
    for (const environment of [
      currentEnvironment({ routeConfigSha256: shaRoute }),
      currentEnvironment({ scope: "native-inventory", routeConfigSha256: shaRoute }),
      managedEnvironment({ nativeSkillInventorySha256: shaInventory }),
      managedEnvironment({ providerDriverKind: null }),
      { ...managedEnvironment(), routeConfigSha256: undefined },
      { ...currentEnvironment(), scope: "managed-procedure/v2" },
    ]) {
      expect(Exit.isFailure(decode(environment))).toBe(true);
    }
  });
});

describe("ProjectSkillHold evidence scope", () => {
  const decode = Schema.decodeUnknownExit(ProjectSkillHold);
  const holdId = ProjectSkillHoldId.make("hold-decode");
  const environmentHold = (overrides: Record<string, unknown>) => ({
    holdId,
    ref,
    kind: "environment-changed",
    observedAtEventSequence: 50,
    failure: null,
    ...overrides,
  });

  it("accepts an unmarked legacy hold and scope-consistent managed holds", () => {
    expect(Exit.isSuccess(decode(environmentHold({ environment: currentEnvironment() })))).toBe(
      true,
    );
    expect(
      Exit.isSuccess(
        decode(
          environmentHold({
            environment: managedEnvironment(),
            evidenceScope: "managed-procedure/v1",
          }),
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          holdId,
          ref,
          kind: "failure-observed",
          observedAtEventSequence: 50,
          failure: { ...checkObservation(), outcome: "failed", tree: null, endedAt: null },
          environment: null,
          evidenceScope: "managed-procedure/v1",
        }),
      ),
    ).toBe(true);
  });

  it("rejects a non-null environment that disagrees with the hold's effective scope", () => {
    expect(Exit.isFailure(decode(environmentHold({ environment: managedEnvironment() })))).toBe(
      true,
    );
    expect(
      Exit.isFailure(
        decode(
          environmentHold({
            environment: currentEnvironment(),
            evidenceScope: "managed-procedure/v1",
          }),
        ),
      ),
    ).toBe(true);
  });
});

describe("projectSkillEnvironmentOf", () => {
  it("returns the canonical environment only for a passed use with confirmed provider fields", () => {
    expect(projectSkillEnvironmentOf(passedUse(evidenceReproduction))).toEqual(
      currentEnvironment(),
    );
    expect(
      projectSkillEnvironmentOf(
        passedUse(evidenceReproduction, {
          check: { outcome: "failed", tree: null, endedAt: null },
        }),
      ),
    ).toBeNull();
    expect(
      projectSkillEnvironmentOf(
        passedUse(evidenceReproduction, { input: { providerDriverKind: null } }),
      ),
    ).toBeNull();
    expect(
      projectSkillEnvironmentOf(
        passedUse(evidenceReproduction, { input: { nativeSkillInventorySha256: null } }),
      ),
    ).toBeNull();
    expect(
      projectSkillEnvironmentOf({
        evidenceId: evidenceReproduction,
        input: inputObservation(),
        check: null,
      }),
    ).toBeNull();
  });

  it("emits check commands deduped per scriptId in sorted order", () => {
    const use = passedUse(evidenceReproduction, {
      check: {
        planned: [
          {
            scriptId: "typecheck",
            scriptName: "Typecheck",
            commandSha256: shaOther,
            timeoutMs: 60_000,
          },
          { scriptId: "lint", scriptName: "Lint", commandSha256: shaCommand, timeoutMs: 60_000 },
          { scriptId: "lint", scriptName: "Lint", commandSha256: shaCommand, timeoutMs: 60_000 },
        ],
      },
    });
    expect(projectSkillEnvironmentOf(use)?.checkCommands).toEqual([
      { scriptId: "lint", commandSha256: shaCommand },
      { scriptId: "typecheck", commandSha256: shaOther },
    ]);
  });
});

describe("projectSkillEnvironmentOf managed evidence", () => {
  it("builds the managed environment from a managed passed use", () => {
    expect(projectSkillEnvironmentOf(managedPassedUse(evidenceReproduction))).toEqual(
      managedEnvironment(),
    );
  });

  it("refuses hand-built managed uses that fail branch eligibility", () => {
    for (const use of [
      managedPassedUse(evidenceReproduction, {
        input: { nativeSkillInventorySha256: shaInventory },
      }),
      managedPassedUse(evidenceReproduction, { input: { providerDriverKind: null } }),
      managedPassedUse(evidenceReproduction, {
        input: { managedSend: managedSendEvidence({ deliveredRef: otherRefA }) },
      }),
      managedPassedUse(evidenceReproduction, {
        check: { outcome: "failed", tree: null, endedAt: null },
      }),
    ]) {
      expect(projectSkillEnvironmentOf(use)).toBeNull();
    }
  });

  it("refuses managed evidence that would not decode when built in memory", () => {
    const rawManagedUse = (managedSend: unknown): ProjectSkillObservedUse =>
      ({
        evidenceId: evidenceReproduction,
        input: { ...inputObservation({ nativeSkillInventorySha256: null }), managedSend },
        check: checkObservation(),
      }) as ProjectSkillObservedUse;
    for (const managedSend of [
      { ...managedSendEvidence(), scope: "native-inventory" },
      { ...managedSendEvidence(), providerInstanceId: "   " },
      { ...managedSendEvidence(), routeConfigSha256: undefined },
    ]) {
      expect(projectSkillEnvironmentOf(rawManagedUse(managedSend))).toBeNull();
    }
  });
});

describe("projectSkillEnvironmentMismatch", () => {
  it("is none only on an exact match, ignoring check-command order", () => {
    const current = currentEnvironment({
      checkCommands: [
        { scriptId: "lint", commandSha256: shaCommand },
        { scriptId: "typecheck", commandSha256: shaOther },
      ],
    });
    const supported = [
      currentEnvironment({
        checkCommands: [
          { scriptId: "typecheck", commandSha256: shaOther },
          { scriptId: "lint", commandSha256: shaCommand },
          { scriptId: "lint", commandSha256: shaCommand },
        ],
      }),
    ];
    expect(projectSkillEnvironmentMismatch({ supported, current })).toBe("none");
  });

  it("reports unsupported-provider for a driver outside the supported set or unconfirmed", () => {
    expect(
      projectSkillEnvironmentMismatch({
        supported: [currentEnvironment()],
        current: currentEnvironment({ providerDriverKind: "codex" }),
      }),
    ).toBe("unsupported-provider");
    expect(
      projectSkillEnvironmentMismatch({
        supported: [currentEnvironment()],
        current: currentEnvironment({ providerDriverKind: null }),
      }),
    ).toBe("unsupported-provider");
    expect(projectSkillEnvironmentMismatch({ supported: [], current: currentEnvironment() })).toBe(
      "unsupported-provider",
    );
  });

  it("reports environment-changed for other drift, never none on unconfirmed fields", () => {
    for (const drift of [
      currentEnvironment({ nativeSkillInventorySha256: shaOther }),
      currentEnvironment({ arch: "x64" }),
      currentEnvironment({ envSha256: shaOther }),
      currentEnvironment({ checkCommands: [{ scriptId: "lint", commandSha256: shaOther }] }),
      currentEnvironment({ nativeSkillInventorySha256: null }),
    ]) {
      expect(
        projectSkillEnvironmentMismatch({ supported: [currentEnvironment()], current: drift }),
      ).toBe("environment-changed");
    }
  });
});

describe("projectSkillEnvironmentMismatch evidence scopes", () => {
  it("is none only within a single scope", () => {
    expect(
      projectSkillEnvironmentMismatch({
        supported: [managedEnvironment()],
        current: managedEnvironment(),
      }),
    ).toBe("none");
    expect(
      projectSkillEnvironmentMismatch({
        supported: [currentEnvironment()],
        current: currentEnvironment(),
      }),
    ).toBe("none");
  });

  it("is environment-changed across scopes in both directions and on route drift", () => {
    for (const mismatch of [
      { supported: [currentEnvironment()], current: managedEnvironment() },
      { supported: [managedEnvironment()], current: currentEnvironment() },
      {
        supported: [managedEnvironment()],
        current: managedEnvironment({ routeConfigSha256: shaOther }),
      },
    ]) {
      expect(projectSkillEnvironmentMismatch(mismatch)).toBe("environment-changed");
    }
  });

  it("keeps unsupported-provider ahead of scope drift", () => {
    expect(
      projectSkillEnvironmentMismatch({
        supported: [managedEnvironment({ providerDriverKind: "codex" })],
        current: managedEnvironment(),
      }),
    ).toBe("unsupported-provider");
    expect(
      projectSkillEnvironmentMismatch({
        supported: [managedEnvironment()],
        current: managedEnvironment({ providerDriverKind: null }),
      }),
    ).toBe("unsupported-provider");
  });

  it("fails closed when typed branch-ineligible environments would otherwise match", () => {
    // Positive control: the same shape with branch-consistent fields is `none`.
    expect(
      projectSkillEnvironmentMismatch({
        supported: [managedEnvironment()],
        current: managedEnvironment(),
      }),
    ).toBe("none");
    expect(
      projectSkillEnvironmentMismatch({
        supported: [managedEnvironment({ nativeSkillInventorySha256: shaInventory })],
        current: managedEnvironment({ nativeSkillInventorySha256: shaInventory }),
      }),
    ).toBe("environment-changed");
    expect(
      projectSkillEnvironmentMismatch({
        supported: [{ ...currentEnvironment(), routeConfigSha256: shaRoute }],
        current: { ...currentEnvironment(), routeConfigSha256: shaRoute },
      }),
    ).toBe("environment-changed");
  });

  it("fails closed on unknown scope versions and malformed digests even when paired", () => {
    const unknownVersion = {
      ...managedEnvironment(),
      scope: "managed-procedure/v2",
    } as unknown as ProjectSkillEnvironment;
    const badDigest = { ...managedEnvironment(), routeConfigSha256: "not-a-digest" };
    // Positive control: the valid managed pair is still `none`.
    expect(
      projectSkillEnvironmentMismatch({
        supported: [managedEnvironment()],
        current: managedEnvironment(),
      }),
    ).toBe("none");
    expect(
      projectSkillEnvironmentMismatch({ supported: [unknownVersion], current: unknownVersion }),
    ).toBe("environment-changed");
    expect(projectSkillEnvironmentMismatch({ supported: [badDigest], current: badDigest })).toBe(
      "environment-changed",
    );
  });

  it("refuses a typed current whose scope is null rather than absent", () => {
    const nullScopeCurrent = {
      ...currentEnvironment(),
      scope: null,
    } as unknown as ProjectSkillEnvironment;
    // Positive control: the same shape with no scope key is `none`.
    expect(
      projectSkillEnvironmentMismatch({
        supported: [currentEnvironment()],
        current: currentEnvironment(),
      }),
    ).toBe("none");
    expect(
      projectSkillEnvironmentMismatch({
        supported: [currentEnvironment()],
        current: nullScopeCurrent,
      }),
    ).toBe("environment-changed");
  });
});

describe("isProjectSkillHoldReleased", () => {
  const target = readyTarget({ state: "active" });
  const holdId = ProjectSkillHoldId.make("hold-1");
  const failureHold = (observedAtEventSequence = 50): ProjectSkillHold => ({
    holdId,
    ref,
    kind: "failure-observed",
    observedAtEventSequence,
    failure: { ...checkObservation(), outcome: "failed", tree: null, endedAt: null },
    environment: null,
  });
  const environmentHold = (observedAtEventSequence = 50): ProjectSkillHold => ({
    holdId,
    ref,
    kind: "environment-changed",
    observedAtEventSequence,
    failure: null,
    environment: currentEnvironment(),
  });
  const release = (
    hold: ProjectSkillHold,
    overrides: Partial<Parameters<typeof isProjectSkillHoldReleased>[0]> = {},
  ) =>
    isProjectSkillHoldReleased({
      hold,
      target,
      current: currentEnvironment(),
      judgments: [
        reproductionJudgment(evidenceReproduction),
        failureClassificationJudgment(holdId, "unrelated"),
      ],
      observedUses: [passedUse(evidenceReproduction, { input: { inputEventSequence: 60 } })],
      ...overrides,
    });

  it("does not release on dismissal words alone", () => {
    expect(
      release(failureHold(), { judgments: [reproductionJudgment(evidenceReproduction)] }),
    ).toBe(false);
    expect(release(failureHold(), { judgments: [] })).toBe(false);
  });

  it("releases a failure hold with an unrelated classification and a later eligible reproduction", () => {
    expect(release(failureHold())).toBe(true);
  });

  it("stays held when the reproduction input predates the hold", () => {
    expect(
      release(failureHold(), {
        observedUses: [passedUse(evidenceReproduction, { input: { inputEventSequence: 40 } })],
      }),
    ).toBe(false);
  });

  it("never releases on a skill-caused classification", () => {
    expect(
      release(failureHold(), {
        judgments: [
          reproductionJudgment(evidenceReproduction),
          failureClassificationJudgment(holdId, "unrelated"),
          failureClassificationJudgment(holdId, "skill-caused"),
        ],
      }),
    ).toBe(false);
  });

  it("ignores classifications and reproductions bound to a different ref", () => {
    const otherRef: ProjectSkillVersionRef = { ...ref, contentSha256: shaOther };
    const unrelatedForOther: ProjectSkillJudgment = {
      ...failureClassificationJudgment(holdId, "unrelated"),
      ref: otherRef,
    };
    const reproductionForOther: ProjectSkillJudgment = {
      ...reproductionJudgment(evidenceReproduction),
      ref: otherRef,
    };
    expect(release(failureHold(), { judgments: [unrelatedForOther, reproductionForOther] })).toBe(
      false,
    );
  });

  it("releases an environment hold on a later eligible reproduction alone", () => {
    expect(
      release(environmentHold(), { judgments: [reproductionJudgment(evidenceReproduction)] }),
    ).toBe(true);
  });

  it("stays held when the only reproduction ran in a different environment", () => {
    expect(
      release(environmentHold(), {
        judgments: [reproductionJudgment(evidenceReproduction)],
        observedUses: [
          passedUse(evidenceReproduction, {
            input: { inputEventSequence: 60, nativeSkillInventorySha256: shaOther },
          }),
        ],
      }),
    ).toBe(false);
  });

  it("never releases a hold that belongs to a different ref", () => {
    expect(release({ ...environmentHold(), ref: otherRefA })).toBe(false);
  });

  const invalidReproductionLegs: ReadonlyArray<{
    name: string;
    use: ProjectSkillObservedUse | null;
    holdSeq?: number;
  }> = [
    {
      name: "a null check",
      use: {
        evidenceId: evidenceReproduction,
        input: inputObservation({ inputEventSequence: 60 }),
        check: null,
      },
    },
    {
      name: "a failed check",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60 },
        check: { outcome: "failed", tree: null, endedAt: null },
      }),
    },
    {
      name: "input and check in different threads",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60 },
        check: { threadId: otherThreadId },
      }),
    },
    {
      name: "an input in a different project",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60, projectId: otherProjectId },
      }),
    },
    {
      name: "a check in a different project",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60 },
        check: { projectId: otherProjectId },
      }),
    },
    {
      name: "an input without the target ref",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60, items: [{ ref: otherRefA, mode: "use" }] },
      }),
    },
    {
      name: "a reproduction in the source thread",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60, threadId: sourceThreadId },
        check: { threadId: sourceThreadId },
      }),
    },
    {
      // The hold predates the input, so only the version watermark leg fails.
      name: "an input at the creation watermark",
      use: passedUse(evidenceReproduction, { input: { inputEventSequence: 20 } }),
      holdSeq: 10,
    },
    {
      name: "a missing evidence lookup",
      use: null,
    },
    {
      name: "an unconfirmed provider driver",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60, providerDriverKind: null },
      }),
    },
    {
      name: "an unconfirmed skill inventory",
      use: passedUse(evidenceReproduction, {
        input: { inputEventSequence: 60, nativeSkillInventorySha256: null },
      }),
    },
  ];

  for (const { name, use, holdSeq = 50 } of invalidReproductionLegs) {
    it(`does not release or ready on ${name}`, () => {
      const uses: ReadonlyArray<ProjectSkillObservedUse> = use === null ? [] : [use];
      expect(
        isProjectSkillHoldReleased({
          hold: environmentHold(holdSeq),
          target,
          current: currentEnvironment(),
          judgments: [reproductionJudgment(evidenceReproduction)],
          observedUses: uses,
        }),
      ).toBe(false);
      expect(derive({ observedUses: [...uses, nonApplicationUse()] }).ready).toBe(false);
    });
  }
});

describe("isProjectSkillHoldReleased evidence scopes", () => {
  const target = readyTarget({ state: "active" });
  const holdId = ProjectSkillHoldId.make("hold-scope");
  const managedReproduction = {
    judgments: [reproductionJudgment(evidenceReproduction)],
    observedUses: [managedPassedUse(evidenceReproduction, { input: { inputEventSequence: 60 } })],
  };
  const legacyEnvironmentHold = (): ProjectSkillHold => ({
    holdId,
    ref,
    kind: "environment-changed",
    observedAtEventSequence: 50,
    failure: null,
    environment: currentEnvironment(),
  });
  const managedEnvironmentHold = (): ProjectSkillHold => ({
    holdId,
    ref,
    kind: "environment-changed",
    observedAtEventSequence: 50,
    failure: null,
    environment: managedEnvironment(),
    evidenceScope: "managed-procedure/v1",
  });
  const managedFailureHold = (): ProjectSkillHold => ({
    holdId,
    ref,
    kind: "failure-observed",
    observedAtEventSequence: 50,
    failure: { ...checkObservation(), outcome: "failed", tree: null, endedAt: null },
    environment: null,
    evidenceScope: "managed-procedure/v1",
  });

  it("never lets a managed reproduction release an old unmarked hold", () => {
    expect(
      isProjectSkillHoldReleased({
        hold: legacyEnvironmentHold(),
        target,
        current: managedEnvironment(),
        ...managedReproduction,
      }),
    ).toBe(false);
  });

  it("never releases a typed hold whose environment disagrees with its scope", () => {
    const mismatchedHold: ProjectSkillHold = {
      holdId,
      ref,
      kind: "environment-changed",
      observedAtEventSequence: 50,
      failure: null,
      environment: currentEnvironment(),
      evidenceScope: "managed-procedure/v1",
    };
    expect(
      isProjectSkillHoldReleased({
        hold: mismatchedHold,
        target,
        current: managedEnvironment(),
        ...managedReproduction,
      }),
    ).toBe(false);
  });

  it("never releases a typed hold whose managed environment is branch-ineligible", () => {
    const holdWithEnvironment = (environment: ProjectSkillEnvironment): ProjectSkillHold => ({
      holdId,
      ref,
      kind: "environment-changed",
      observedAtEventSequence: 50,
      failure: null,
      environment,
      evidenceScope: "managed-procedure/v1",
    });
    const releaseWith = (environment: ProjectSkillEnvironment) =>
      isProjectSkillHoldReleased({
        hold: holdWithEnvironment(environment),
        target,
        current: managedEnvironment(),
        ...managedReproduction,
      });
    expect(releaseWith(managedEnvironment({ nativeSkillInventorySha256: shaInventory }))).toBe(
      false,
    );
    expect(
      releaseWith({
        ...managedEnvironment(),
        routeConfigSha256: undefined,
      } as unknown as ProjectSkillEnvironment),
    ).toBe(false);
    // A branch-valid same-scope hold still releases.
    expect(releaseWith(managedEnvironment())).toBe(true);
  });

  it("refuses a typed hold whose evidenceScope is null rather than absent", () => {
    const holdWithScope = (evidenceScope: unknown): ProjectSkillHold =>
      ({
        holdId,
        ref,
        kind: "environment-changed",
        observedAtEventSequence: 50,
        failure: null,
        environment: currentEnvironment(),
        evidenceScope,
      }) as unknown as ProjectSkillHold;
    const legacyReproduction = {
      judgments: [reproductionJudgment(evidenceReproduction)],
      observedUses: [passedUse(evidenceReproduction, { input: { inputEventSequence: 60 } })],
    };
    // Positive control: the unmarked hold of the same shape still releases.
    expect(
      isProjectSkillHoldReleased({
        hold: holdWithScope(undefined),
        target,
        current: currentEnvironment(),
        ...legacyReproduction,
      }),
    ).toBe(true);
    expect(
      isProjectSkillHoldReleased({
        hold: holdWithScope(null),
        target,
        current: currentEnvironment(),
        ...legacyReproduction,
      }),
    ).toBe(false);
  });

  it("releases a managed hold only on a same-scope reproduction", () => {
    expect(
      isProjectSkillHoldReleased({
        hold: managedEnvironmentHold(),
        target,
        current: managedEnvironment(),
        ...managedReproduction,
      }),
    ).toBe(true);
    expect(
      isProjectSkillHoldReleased({
        hold: managedEnvironmentHold(),
        target,
        current: currentEnvironment(),
        judgments: [reproductionJudgment(evidenceReproduction)],
        observedUses: [passedUse(evidenceReproduction, { input: { inputEventSequence: 60 } })],
      }),
    ).toBe(false);
  });

  it("releases a managed failure hold only through the unrelated classification", () => {
    expect(
      isProjectSkillHoldReleased({
        hold: managedFailureHold(),
        target,
        current: managedEnvironment(),
        ...managedReproduction,
      }),
    ).toBe(false);
    expect(
      isProjectSkillHoldReleased({
        hold: managedFailureHold(),
        target,
        current: managedEnvironment(),
        judgments: [
          ...managedReproduction.judgments,
          failureClassificationJudgment(holdId, "unrelated"),
        ],
        observedUses: managedReproduction.observedUses,
      }),
    ).toBe(true);
  });

  it("never releases a managed hold on a skill-caused classification", () => {
    expect(
      isProjectSkillHoldReleased({
        hold: managedEnvironmentHold(),
        target,
        current: managedEnvironment(),
        judgments: [
          reproductionJudgment(evidenceReproduction),
          failureClassificationJudgment(holdId, "unrelated"),
          failureClassificationJudgment(holdId, "skill-caused"),
        ],
        observedUses: managedReproduction.observedUses,
      }),
    ).toBe(false);
  });
});

describe("deriveProjectSkillReadiness", () => {
  it("reports ready for a fully evidenced activate", () => {
    expectGaps(derive(), []);
  });

  it("reports ready for use only on an active version", () => {
    expectGaps(derive({ purpose: "use", target: readyTarget({ state: "active" }) }), []);
    expectGaps(derive({ purpose: "use" }), ["state"]);
  });

  it("reports every missing gate for a first success that only has its source", () => {
    expectGaps(derive({ judgments: [], observedUses: [] }), [
      "rights-unreviewed",
      "review-missing",
      "reproduction-missing",
      "non-application-missing",
    ]);
  });

  it("reports rights-unreviewed alone when only the rights judgment is absent", () => {
    expectGaps(derive({ judgments: readyJudgments().filter((j) => j.kind !== "rights") }), [
      "rights-unreviewed",
    ]);
  });

  it("binds judgments to the exact ref — a judgment for another version does not count", () => {
    const rightsForOther: ProjectSkillJudgment = { ...rightsJudgment(), ref: otherRefA };
    expectGaps(
      derive({
        judgments: [rightsForOther, ...readyJudgments().filter((j) => j.kind !== "rights")],
      }),
      ["rights-unreviewed"],
    );
  });

  it("reports reproduction-missing when the reproduction ran in the source thread", () => {
    expectGaps(
      derive({
        observedUses: [
          passedUse(evidenceReproduction, {
            input: { threadId: sourceThreadId },
            check: { threadId: sourceThreadId },
          }),
          nonApplicationUse(),
        ],
      }),
      ["reproduction-missing"],
    );
  });

  it("reports reproduction-missing when the judgment names a different version or sha", () => {
    const base = readyJudgments().filter((j) => j.kind !== "reproduction");
    const forOtherVersion: ProjectSkillJudgment = {
      ...reproductionJudgment(evidenceReproduction),
      ref: otherRefA,
    };
    const forOtherSha: ProjectSkillJudgment = {
      ...reproductionJudgment(evidenceReproduction),
      ref: { ...ref, contentSha256: shaOther },
    };
    expectGaps(derive({ judgments: [...base, forOtherVersion] }), ["reproduction-missing"]);
    expectGaps(derive({ judgments: [...base, forOtherSha] }), ["reproduction-missing"]);
  });

  it("reports reproduction-missing when the use exists without the judgment", () => {
    expectGaps(derive({ judgments: readyJudgments().filter((j) => j.kind !== "reproduction") }), [
      "reproduction-missing",
    ]);
  });

  it("reports reproduction-missing when the observed outcome was failed", () => {
    expectGaps(
      derive({
        observedUses: [
          passedUse(evidenceReproduction, {
            check: { outcome: "failed", tree: null, endedAt: null },
          }),
          nonApplicationUse(),
        ],
      }),
      ["reproduction-missing"],
    );
  });

  it("reports non-application-harmful even beside a clean non-application judgment", () => {
    expectGaps(
      derive({
        judgments: [...readyJudgments(), nonApplicationJudgment(evidenceNonApplication, "harmful")],
      }),
      ["non-application-harmful"],
    );
  });

  it("reports screen when screening rejected the content", () => {
    expectGaps(derive({ screenReasons: ["sensitive"] }), ["screen"]);
  });

  it("accepts an interference judgment whose coActive set matches the active set", () => {
    expectGaps(
      derive({
        otherActive: [otherRefA, otherRefB],
        observedUses: [
          ...readyObservedUses(),
          {
            evidenceId: evidenceInterference,
            input: inputObservation({
              items: [
                { ref, mode: "use" },
                { ref: otherRefA, mode: "use" },
                { ref: otherRefB, mode: "use" },
              ],
            }),
            check: checkObservation(),
          },
        ],
        judgments: [
          ...readyJudgments(),
          interferenceJudgment(evidenceInterference, [otherRefB, otherRefA]),
        ],
      }),
      [],
    );
  });

  it("reports interference-missing when the recorded coActive set differs from the active set", () => {
    expectGaps(
      derive({
        otherActive: [otherRefA, otherRefB],
        judgments: [...readyJudgments(), interferenceJudgment(evidenceInterference, [otherRefA])],
      }),
      ["interference-missing"],
    );
  });

  it("reports interference-observed when an interference verdict overlaps the active set", () => {
    expectGaps(
      derive({
        otherActive: [otherRefA],
        judgments: [
          ...readyJudgments(),
          interferenceJudgment(evidenceInterference, [otherRefA], "interference"),
        ],
      }),
      ["interference-missing", "interference-observed"],
    );
  });

  it("requires no interference evidence when nothing else is active", () => {
    expectGaps(
      derive({
        otherActive: [],
        judgments: [
          ...readyJudgments(),
          interferenceJudgment(evidenceInterference, [otherRefA], "interference"),
        ],
      }),
      [],
    );
  });

  it("reports open-hold for an unreleased hold and clears once released", () => {
    const hold: ProjectSkillHold = {
      holdId: ProjectSkillHoldId.make("hold-open"),
      ref,
      kind: "environment-changed",
      observedAtEventSequence: 45,
      failure: null,
      environment: currentEnvironment(),
    };
    expectGaps(derive({ holds: [hold] }), ["open-hold"]);
    expectGaps(derive({ holds: [{ ...hold, observedAtEventSequence: 35 }] }), []);
  });

  it("reports unsupported-provider when the only reproduction ran on another driver", () => {
    expectGaps(derive({ current: currentEnvironment({ providerDriverKind: "codex" }) }), [
      "unsupported-provider",
    ]);
  });

  it("reports environment-changed when the inventory digest differs", () => {
    expectGaps(derive({ current: currentEnvironment({ nativeSkillInventorySha256: shaOther }) }), [
      "environment-changed",
    ]);
  });

  it("reports environment-changed deterministically across candidate and observation order", () => {
    // One reproduction ran on the current driver with a stale inventory, the
    // other on a different driver. The current driver is in the reproduced
    // support set, so the gap is environment-changed no matter the order.
    const staleInventoryUse = passedUse(evidenceReproductionAlt, {
      input: { nativeSkillInventorySha256: shaOther },
    });
    const codexUse = passedUse(evidenceCodex, {
      input: { providerDriverKind: "codex" },
    });
    const staleJudgment = reproductionJudgment(evidenceReproductionAlt);
    const codexJudgment = reproductionJudgment(evidenceCodex);
    const base = readyJudgments().filter((j) => j.kind !== "reproduction");
    const judgmentOrders: ReadonlyArray<ReadonlyArray<ProjectSkillJudgment>> = [
      [...base, codexJudgment, staleJudgment],
      [...base, staleJudgment, codexJudgment],
    ];
    const useOrders: ReadonlyArray<ReadonlyArray<ProjectSkillObservedUse>> = [
      [staleInventoryUse, codexUse, nonApplicationUse()],
      [codexUse, staleInventoryUse, nonApplicationUse()],
    ];
    for (const judgments of judgmentOrders) {
      for (const observedUses of useOrders) {
        const result = derive({ judgments, observedUses });
        expect(result.gaps).toEqual(["environment-changed"]);
        expect(result.ready).toBe(false);
      }
    }
  });

  it("excludes the root source thread and applies the revision's own watermark", () => {
    const revisionTarget = readyTarget({
      source: {
        type: "revision",
        fromVersion: 1,
        createdAfterEventSequence: 60,
        root: workSource(),
      },
    });
    // Postdates the root's watermark (20) but not the revision's own (60).
    expectGaps(
      derive({
        target: revisionTarget,
        observedUses: [
          passedUse(evidenceReproduction, { input: { inputEventSequence: 50 } }),
          nonApplicationUse(),
        ],
      }),
      ["reproduction-missing"],
    );
    // The excluded thread is the root work check's thread.
    expectGaps(
      derive({
        target: revisionTarget,
        observedUses: [
          passedUse(evidenceReproduction, {
            input: { inputEventSequence: 65, threadId: sourceThreadId },
            check: { threadId: sourceThreadId },
          }),
          nonApplicationUse(),
        ],
      }),
      ["reproduction-missing"],
    );
    // A reproduction after the revision watermark in a different thread is eligible.
    expectGaps(
      derive({
        target: revisionTarget,
        observedUses: [
          passedUse(evidenceReproduction, { input: { inputEventSequence: 65 } }),
          nonApplicationUse(),
        ],
      }),
      [],
    );
  });

  it("allows activate on a retireable retired version but not a failed-in-use one", () => {
    expectGaps(
      derive({ target: readyTarget({ state: "retired", retiredReason: "superseded" }) }),
      [],
    );
    for (const reason of ["failed-in-use", "rejected"] as const) {
      expectGaps(derive({ target: readyTarget({ state: "retired", retiredReason: reason }) }), [
        "state",
      ]);
    }
  });
});

describe("deriveProjectSkillReadiness managed evidence", () => {
  const managedDerive = (
    overrides: Partial<Parameters<typeof deriveProjectSkillReadiness>[0]> = {},
  ) => derive({ current: managedEnvironment(), ...overrides });

  it("reports ready on a managed reproduction against a managed current", () => {
    expectGaps(
      managedDerive({
        observedUses: [managedPassedUse(evidenceReproduction), nonApplicationUse()],
      }),
      [],
    );
  });

  it("refuses old unmarked null observations for a managed current", () => {
    expectGaps(
      managedDerive({
        observedUses: [
          passedUse(evidenceReproduction, { input: { nativeSkillInventorySha256: null } }),
          nonApplicationUse(),
        ],
      }),
      ["environment-changed"],
    );
  });

  it("refuses a valid legacy reproduction as scope drift for a managed current", () => {
    expectGaps(managedDerive(), ["environment-changed"]);
  });

  it("refuses a managed send whose deliveredRef does not name the target", () => {
    expectGaps(
      managedDerive({
        observedUses: [
          managedPassedUse(evidenceReproduction, {
            input: { managedSend: managedSendEvidence({ deliveredRef: otherRefA }) },
          }),
          nonApplicationUse(),
        ],
      }),
      ["reproduction-missing"],
    );
  });

  it("refuses managed evidence with a null or missing deliveredRef without throwing", () => {
    const rawManagedUse = (managedSend: unknown): ProjectSkillObservedUse =>
      ({
        evidenceId: evidenceReproduction,
        input: {
          ...inputObservation({ inputEventSequence: 60, nativeSkillInventorySha256: null }),
          managedSend,
        },
        check: checkObservation(),
      }) as ProjectSkillObservedUse;
    const hold: ProjectSkillHold = {
      holdId: ProjectSkillHoldId.make("hold-refless"),
      ref,
      kind: "environment-changed",
      observedAtEventSequence: 50,
      failure: null,
      environment: managedEnvironment(),
      evidenceScope: "managed-procedure/v1",
    };
    const releaseOn = (observedUses: ReadonlyArray<ProjectSkillObservedUse>) =>
      isProjectSkillHoldReleased({
        hold,
        target: readyTarget({ state: "active" }),
        current: managedEnvironment(),
        judgments: [reproductionJudgment(evidenceReproduction)],
        observedUses,
      });
    // Same-path positive control: valid raw evidence past the hold watermark
    // is ready and releases, so the negatives refuse on the evidence alone.
    const validUse = rawManagedUse(managedSendEvidence());
    expect(managedDerive({ observedUses: [validUse, nonApplicationUse()] }).ready).toBe(true);
    expect(releaseOn([validUse])).toBe(true);
    const missingRef: Record<string, unknown> = { ...managedSendEvidence() };
    delete missingRef.deliveredRef;
    for (const managedSend of [
      null,
      missingRef,
      { ...managedSendEvidence(), deliveredRef: null },
    ]) {
      const use = rawManagedUse(managedSend);
      expect(managedDerive({ observedUses: [use, nonApplicationUse()] }).ready).toBe(false);
      expect(releaseOn([use])).toBe(false);
    }
  });

  it("keeps source-thread and watermark restrictions on managed reproductions", () => {
    expectGaps(
      managedDerive({
        observedUses: [
          managedPassedUse(evidenceReproduction, {
            input: { threadId: sourceThreadId },
            check: { threadId: sourceThreadId },
          }),
          nonApplicationUse(),
        ],
      }),
      ["reproduction-missing"],
    );
    expectGaps(
      managedDerive({
        observedUses: [
          managedPassedUse(evidenceReproduction, { input: { inputEventSequence: 20 } }),
          nonApplicationUse(),
        ],
      }),
      ["reproduction-missing"],
    );
  });

  it("counts a valid managed reproduction beside unrelated legacy history", () => {
    expectGaps(
      managedDerive({
        observedUses: [
          passedUse(evidenceReproduction),
          managedPassedUse(evidenceReproductionAlt),
          nonApplicationUse(),
        ],
        judgments: [...readyJudgments(), reproductionJudgment(evidenceReproductionAlt)],
      }),
      [],
    );
  });
});
