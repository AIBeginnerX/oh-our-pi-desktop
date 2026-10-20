// Pure decision tests for the trial send dialog: the version-skew-safe
// capability read, the scope key, the exact send body (block + task + one
// managed record, no client stamp), the fresh-observation gate ordering, and
// the fixed outcome copy. The full component flow lives in the .test.tsx.
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ProjectSkillContextPayload, renderProjectSkillBlock } from "@t3tools/contracts";
import type {
  ProjectId,
  ProjectSkillContent,
  ProjectSkillDetail,
  ProjectSkillVersionRef,
  ProjectSkillVersionView,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";

import {
  activeVersionRefFromDetail,
  buildTrialSendDraft,
  freezeSelectedScriptIds,
  PROJECT_SKILL_TRIAL_RECORD_LABEL,
  PROJECT_SKILL_USE_RECORD_LABEL,
  TRIAL_AUTHORIZATION_COPY,
  TRIAL_DETAIL_FAILED_COPY,
  TRIAL_SEND_UNCONFIRMED_COPY,
  TRIAL_THREAD_UNAVAILABLE_COPY,
  TRIAL_UNSUPPORTED_COPY,
  TRIAL_VERSION_GONE_COPY,
  USE_SCRIPTS_CHANGED_COPY,
  USE_UNSUPPORTED_COPY,
  USE_VERSION_GONE_COPY,
  classifyTrialSendFailure,
  freezeUseScriptBindings,
  frozenUseScriptBindingsStillValid,
  trialCapabilityOf,
  trialScopeKey,
  trialScopeProblem,
  trialSendFailureCopy,
  useCapabilityOf,
  type FrozenTrialScope,
} from "./ProjectSkillTrialDialog.logic";

const decodeProjectSkillContextPayload = Schema.decodeUnknownSync(ProjectSkillContextPayload);

const ENV = "env-a" as EnvironmentId;
const PROJECT = "project-a" as ProjectId;
const THREAD = "thread-a" as ThreadId;

const sha = (prefix: string) => (prefix + "0".repeat(64)).slice(0, 64);
const refV1: ProjectSkillVersionRef = {
  projectId: PROJECT,
  skillId: "psk_aaaa1111" as ProjectSkillVersionRef["skillId"],
  version: 1,
  contentSha256: sha("a"),
};
const contentV1: ProjectSkillContent = {
  title: "Deploy site",
  purpose: "Ship the staging build",
  appliesWhen: "Staging is behind",
  doesNotApplyWhen: "Production",
  procedure: "1. Build\n2. Deploy",
  successCheck: "Selected checks pass: lint",
};

const scope: FrozenTrialScope = { environmentId: ENV, projectId: PROJECT, threadId: THREAD };

const versionView = (
  ref: ProjectSkillVersionRef,
  state: ProjectSkillVersionView["version"]["state"] = "candidate",
): ProjectSkillVersionView => ({
  version: {
    ref,
    content: contentV1,
    source: {
      type: "work",
      check: {} as never,
      createdAfterEventSequence: 5,
      draft: { type: "typed" },
    },
    state,
    retiredReason: null,
    createdAt: "2026-10-11T00:00:00.000Z",
  },
  judgments: [],
  rightsRecorded: false,
  reviewRecorded: false,
  trials: [],
});

const detailFor = (ref: ProjectSkillVersionRef): ProjectSkillDetail => ({
  projectId: ref.projectId,
  skillId: ref.skillId,
  latestVersion: ref.version,
  versions: [versionView(ref)],
});

const observations = (
  overrides: Partial<{
    capability: boolean;
    shell: { projectId: ProjectId; createdAt: string } | null;
    detail: ProjectSkillDetail | null;
  }> = {},
) => ({
  capability: true,
  shell: { projectId: PROJECT, createdAt: "2026-10-11T00:00:00.000Z" },
  detail: detailFor(refV1),
  ...overrides,
});

describe("useCapabilityOf", () => {
  it("is false unless the explicit use flag is true", () => {
    expect(useCapabilityOf(null)).toBe(false);
    expect(
      useCapabilityOf({ environment: { capabilities: { projectSkills: { trial: true } } } }),
    ).toBe(false);
    expect(
      useCapabilityOf({ environment: { capabilities: { projectSkills: { use: true } } } }),
    ).toBe(true);
  });
});

describe("freezeSelectedScriptIds", () => {
  it("accepts only the selected-check script id validator and returns a copied array", () => {
    const source = ["lint"];
    const frozen = freezeSelectedScriptIds(source);
    expect(frozen).toEqual(["lint"]);
    expect(frozen).not.toBe(source);
    expect(freezeSelectedScriptIds([])).toBeNull();
    expect(freezeSelectedScriptIds(["lint", "lint"])).toBeNull();
  });
});

describe("freezeUseScriptBindings", () => {
  it("pins id and command and rejects drift on command change", () => {
    const scripts = [
      { id: "lint", name: "Lint", command: "pnpm lint" },
      { id: "test", name: "Test", command: "pnpm test" },
    ] as const;
    const frozen = freezeUseScriptBindings(["lint"], scripts);
    expect(frozen).toEqual([{ id: "lint", command: "pnpm lint" }]);
    expect(frozenUseScriptBindingsStillValid(frozen!, [{ id: "lint", command: "pnpm lint" }])).toBe(
      true,
    );
    expect(
      frozenUseScriptBindingsStillValid(frozen!, [{ id: "lint", command: "pnpm lint --fix" }]),
    ).toBe(false);
  });
});

describe("activeVersionRefFromDetail", () => {
  it("returns the active ref even when the summary latest is a newer candidate", () => {
    const refV2 = { ...refV1, version: 2, contentSha256: sha("b") };
    const detail: ProjectSkillDetail = {
      projectId: PROJECT,
      skillId: refV1.skillId,
      latestVersion: 2,
      versions: [versionView(refV1, "active"), versionView(refV2, "candidate")],
    };
    expect(activeVersionRefFromDetail(detail)).toEqual(refV1);
  });
});

describe("trialCapabilityOf", () => {
  it("is false for every absent or malformed capability shape", () => {
    expect(trialCapabilityOf(null)).toBe(false);
    expect(trialCapabilityOf(undefined)).toBe(false);
    expect(trialCapabilityOf({ environment: { capabilities: {} } })).toBe(false);
    expect(
      trialCapabilityOf({ environment: { capabilities: { projectSkills: { manage: true } } } }),
    ).toBe(false);
    expect(
      trialCapabilityOf({ environment: { capabilities: { projectSkills: { trial: "yes" } } } }),
    ).toBe(false);
  });

  it("is true only for the explicit trial flag", () => {
    expect(
      trialCapabilityOf({
        environment: { capabilities: { projectSkills: { manage: true, trial: true } } },
      }),
    ).toBe(true);
    expect(
      trialCapabilityOf({
        environment: { capabilities: { projectSkills: { manage: false, trial: true } } },
      }),
    ).toBe(true);
    expect(
      trialCapabilityOf({
        environment: { capabilities: { projectSkills: { manage: true, trial: false } } },
      }),
    ).toBe(false);
  });
});

describe("trialScopeKey", () => {
  it("changes with any scope member so a change remounts the dialog", () => {
    const base = trialScopeKey(scope);
    expect(trialScopeKey({ ...scope })).toBe(base);
    expect(trialScopeKey({ ...scope, projectId: "project-b" as ProjectId })).not.toBe(base);
    expect(trialScopeKey({ ...scope, threadId: "thread-b" as ThreadId })).not.toBe(base);
    expect(trialScopeKey({ ...scope, environmentId: "env-b" as EnvironmentId })).not.toBe(base);
  });
});

describe("buildTrialSendDraft", () => {
  it("sends the exact rendered trial block, a blank line, then the task", () => {
    const draft = buildTrialSendDraft({
      ref: refV1,
      content: contentV1,
      task: "  스테이징 배포를 시험해 주세요  ",
      contextId: "project-skill_test-1" as never,
    });
    expect(draft).not.toBeNull();
    expect(draft!.text).toBe(
      `${renderProjectSkillBlock({ ref: refV1, content: contentV1, mode: "trial" })}\n\n스테이징 배포를 시험해 주세요`,
    );
  });

  it("carries one managed record with a generic label and no client stamp", () => {
    const draft = buildTrialSendDraft({
      ref: refV1,
      content: contentV1,
      task: "task",
      contextId: "project-skill_test-2" as never,
    });
    expect(draft!.context).toEqual({
      version: 1,
      records: [
        {
          version: 1,
          contextId: "project-skill_test-2",
          kind: "project-skill",
          label: PROJECT_SKILL_TRIAL_RECORD_LABEL,
          payload: { ref: refV1, mode: "trial" },
        },
      ],
    });
    const record = draft!.context.records[0]!;
    expect(record.kind).toBe("project-skill");
    if (record.kind !== "project-skill") return;
    // The admission stamp is server-owned: decode against the contract payload schema.
    const payload = decodeProjectSkillContextPayload(record.payload);
    expect(Object.keys(payload)).toEqual(["ref", "mode"]);
    expect(draft!.context.records).toHaveLength(1);
  });

  it("builds a use payload with frozen script ids and no client stamp", () => {
    const refActive = { ...refV1, version: 1 };
    const draft = buildTrialSendDraft({
      ref: refActive,
      content: contentV1,
      task: "과제",
      mode: "use",
      selectedScriptIds: ["lint", "test"],
      contextId: "project-skill_use-1" as never,
    });
    expect(draft).not.toBeNull();
    expect(draft!.text).toBe(
      `${renderProjectSkillBlock({ ref: refActive, content: contentV1, mode: "use" })}\n\n과제`,
    );
    const record = draft!.context.records[0]!;
    expect(record.kind).toBe("project-skill");
    if (record.kind !== "project-skill") return;
    expect(record).toMatchObject({
      label: PROJECT_SKILL_USE_RECORD_LABEL,
      payload: { ref: refActive, mode: "use", selectedScriptIds: ["lint", "test"] },
    });
    const payload = decodeProjectSkillContextPayload(record.payload);
    expect(Object.keys(payload)).toEqual(["ref", "mode", "selectedScriptIds"]);
  });

  it("refuses a blank or whitespace-only task", () => {
    expect(
      buildTrialSendDraft({ ref: refV1, content: contentV1, task: "", contextId: "x" as never }),
    ).toBeNull();
    expect(
      buildTrialSendDraft({ ref: refV1, content: contentV1, task: "   ", contextId: "x" as never }),
    ).toBeNull();
  });
});

describe("trialScopeProblem", () => {
  it("passes when capability, thread, project, and the frozen ref all hold", () => {
    expect(trialScopeProblem({ observations: observations(), scope, frozenRef: refV1 })).toBeNull();
  });

  it("refuses when the bound shell incarnation no longer matches", () => {
    expect(
      trialScopeProblem({
        observations: observations({
          shell: { projectId: PROJECT, createdAt: "2026-10-12T00:00:00.000Z" },
        }),
        scope,
        frozenRef: refV1,
        boundShellCreatedAt: "2026-10-11T00:00:00.000Z",
      }),
    ).toBe(TRIAL_THREAD_UNAVAILABLE_COPY);
  });

  it("orders capability loss first", () => {
    expect(
      trialScopeProblem({
        observations: observations({ capability: false }),
        scope,
        frozenRef: refV1,
      }),
    ).toBe(TRIAL_UNSUPPORTED_COPY);
  });

  it("refuses a missing thread shell or a project change", () => {
    expect(
      trialScopeProblem({ observations: observations({ shell: null }), scope, frozenRef: refV1 }),
    ).toBe(TRIAL_THREAD_UNAVAILABLE_COPY);
    expect(
      trialScopeProblem({
        observations: observations({
          shell: { projectId: "project-b" as ProjectId, createdAt: "2026-10-11T00:00:00.000Z" },
        }),
        scope,
        frozenRef: refV1,
      }),
    ).toBe(TRIAL_THREAD_UNAVAILABLE_COPY);
    expect(
      trialScopeProblem({
        observations: observations(),
        scope,
        frozenRef: { ...refV1, projectId: "project-b" as ProjectId },
      }),
    ).toBe(TRIAL_THREAD_UNAVAILABLE_COPY);
  });

  it("in use mode requires an active frozen ref and stable script ids", () => {
    const activeRef = refV1;
    const activeDetail: ProjectSkillDetail = {
      projectId: PROJECT,
      skillId: refV1.skillId,
      latestVersion: 2,
      versions: [
        versionView(activeRef, "active"),
        versionView({ ...refV1, version: 2, contentSha256: sha("c") }, "candidate"),
      ],
    };
    expect(
      trialScopeProblem({
        mode: "use",
        observations: observations({ detail: activeDetail }),
        scope,
        frozenRef: activeRef,
        frozenScriptBindings: [{ id: "lint", command: "pnpm lint" }],
        scripts: [{ id: "lint", command: "pnpm lint" }],
      }),
    ).toBeNull();
    expect(
      trialScopeProblem({
        mode: "use",
        observations: observations({ detail: activeDetail }),
        scope,
        frozenRef: { ...refV1, version: 2, contentSha256: sha("c") },
      }),
    ).toBe(USE_VERSION_GONE_COPY);
    expect(
      trialScopeProblem({
        mode: "use",
        observations: observations({ capability: false }),
        scope,
        frozenRef: activeRef,
      }),
    ).toBe(USE_UNSUPPORTED_COPY);
    expect(
      trialScopeProblem({
        mode: "use",
        observations: observations({ detail: activeDetail }),
        scope,
        frozenRef: activeRef,
        frozenScriptBindings: [{ id: "lint", command: "pnpm lint" }],
        scripts: [{ id: "test", command: "pnpm test" }],
      }),
    ).toBe(USE_SCRIPTS_CHANGED_COPY);
  });

  it("refuses an unsettled detail and a frozen ref the detail no longer has", () => {
    expect(
      trialScopeProblem({ observations: observations({ detail: null }), scope, frozenRef: refV1 }),
    ).toBe(TRIAL_DETAIL_FAILED_COPY);
    expect(
      trialScopeProblem({
        observations: observations({ detail: detailFor({ ...refV1, version: 2 }) }),
        scope,
        frozenRef: refV1,
      }),
    ).toBe(TRIAL_VERSION_GONE_COPY);
    expect(
      trialScopeProblem({
        observations: observations({
          detail: detailFor({ ...refV1, contentSha256: sha("b") }),
        }),
        scope,
        frozenRef: refV1,
      }),
    ).toBe(TRIAL_VERSION_GONE_COPY);
  });
});

const SENTINEL = "SENTINEL-SERVER-DETAIL-LEAK";

describe("trialSendFailureCopy", () => {
  it("separates authorization loss from unconfirmed transport outcomes", () => {
    expect(
      trialSendFailureCopy(classifyTrialSendFailure({ _tag: "EnvironmentAuthorizationError" })),
    ).toBe(TRIAL_AUTHORIZATION_COPY);
    expect(trialSendFailureCopy(classifyTrialSendFailure(new Error(`${SENTINEL} boom`)))).toBe(
      TRIAL_SEND_UNCONFIRMED_COPY,
    );
    expect(
      trialSendFailureCopy(classifyTrialSendFailure({ _tag: "SomethingElse", message: SENTINEL })),
    ).toBe(TRIAL_SEND_UNCONFIRMED_COPY);
    expect(trialSendFailureCopy(classifyTrialSendFailure(undefined))).toBe(
      TRIAL_SEND_UNCONFIRMED_COPY,
    );
    expect(TRIAL_SEND_UNCONFIRMED_COPY).not.toContain(SENTINEL);
    expect(TRIAL_AUTHORIZATION_COPY).not.toContain(SENTINEL);
  });
});
