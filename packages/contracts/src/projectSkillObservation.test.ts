import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, MessageId, ProjectId, ThreadId } from "./baseSchemas.ts";
import type { OrchestrationLatestTurnState } from "./orchestration.ts";
import {
  ProjectSkillCheckObservation,
  ProjectSkillContent,
  ProjectSkillId,
  ProjectSkillInputObservation,
  ProjectSkillMode,
  ProjectSkillReadinessGap,
  ProjectSkillVersionRef,
  renderProjectSkillBlock,
} from "./projectSkill.ts";
import {
  type SelectedCheckPlannedCheck,
  type SelectedCheckReceipt,
  type SelectedCheckResult,
  type SelectedChecksGetResult,
  deriveSelectedCheckState,
} from "./selectedChecks.ts";
import {
  evaluateProjectSkillAdmission,
  evaluateSkillSource,
  evaluateSkillUseWindow,
} from "./projectSkillObservation.ts";

const sha256 = "a".repeat(64);
const otherSha256 = "b".repeat(64);
const treeOid = "c".repeat(40);
const thread = ThreadId.make("thread-1");
const otherThread = ThreadId.make("thread-2");
const project = ProjectId.make("project-1");
const otherProject = ProjectId.make("project-2");
const environmentId = EnvironmentId.make("env-1");
const attemptId = "attempt-1";

const skillRef = (contentSha256 = sha256, version = 1): ProjectSkillVersionRef => ({
  projectId: project,
  skillId: ProjectSkillId.make("psk_abcd1234"),
  version,
  contentSha256,
});
const refV1 = skillRef();
const refV2 = skillRef(otherSha256, 2);

const skillContent = (): ProjectSkillContent => ({
  title: "Release the web app",
  purpose: "Ship a tagged release through the checked pipeline.",
  appliesWhen: "The user asks to cut a release.",
  doesNotApplyWhen: "The user asks for a hotfix outside the pipeline.",
  procedure: "1. Install dependencies.\n2. Run the release script.\n3. Tag the commit.",
  successCheck: "The release test script exits 0.",
});

const plannedCheck = (scriptId: string, scriptName: string): SelectedCheckPlannedCheck => ({
  scriptId,
  scriptName,
  commandSha256: sha256,
  timeoutMs: 60_000,
});

const passedCheck = (
  scriptId: string,
  startedAt: string,
  endedAt: string,
): SelectedCheckResult => ({
  scriptId,
  status: "passed",
  startedAt,
  endedAt,
  exitCode: 0,
  exitedBy: "exit",
  exitSignal: null,
  pgid: 41234,
  group: "empty",
  stdout: { bytes: 120, sha256 },
  stderr: { bytes: 0, sha256: "e".repeat(64) },
  failure: null,
});

/**
 * A receipt of the exact shape a completed attempt writes, bound to the
 * window numbers the use-window tests use: first receipt write at sequence
 * 20, terminal event row at 40, the input at 10, the next input at 100.
 * Written by hand here, as in the selectedChecks tests: decoding it and
 * running it through the derivations proves the schemas agree and is never
 * evidence that a server executed anything.
 */
const passingReceipt = (): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId: thread,
  attemptId,
  revision: 2,
  threadAnchorSequence: 20,
  context: {
    projectId: project,
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    cwd: "/tmp/workspace",
    shell: "/bin/zsh",
    envSha256: sha256,
  },
  planned: [plannedCheck("lint", "Lint"), plannedCheck("test", "Test")],
  environment: {
    environmentId,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "22.11.0",
  },
  tree: {
    atStart: { kind: "complete", treeOid },
    atEnd: { kind: "complete", treeOid },
    repoAtStart: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
    repoAtEnd: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
  },
  phase: "completed",
  checks: [
    passedCheck("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
    passedCheck("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
  ],
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: "2026-08-20T12:01:00Z",
  error: null,
});

const recordAt = (
  sequence: number,
  receipt: SelectedCheckReceipt = passingReceipt(),
): SelectedChecksGetResult["record"] => ({ kind: "present", receipt, sequence });

const checksResult = (
  record: SelectedChecksGetResult["record"],
  changedScriptIds: ReadonlyArray<string> = [],
): SelectedChecksGetResult => ({
  capability: { available: true, reason: null },
  record,
  changedScriptIds: [...changedScriptIds],
  admission: { state: "open" },
});

const inputObservation = (
  overrides: Partial<ProjectSkillInputObservation> = {},
): ProjectSkillInputObservation => ({
  threadId: thread,
  projectId: project,
  messageId: MessageId.make("message-1"),
  inputEventSequence: 10,
  admittedSkillStateSeq: 3,
  providerDriverKind: "claude-code",
  nativeSkillInventorySha256: sha256,
  items: [{ ref: refV1, mode: "use" }],
  ...overrides,
});

const sourceThread = (): {
  threadId: ThreadId;
  projectId: ProjectId;
  worktreePath: string | null;
  latestTurnState: OrchestrationLatestTurnState | null;
} => ({
  threadId: thread,
  projectId: project,
  worktreePath: null,
  latestTurnState: "completed",
});

const sourceInput = (
  record: SelectedChecksGetResult["record"],
  thread: Parameters<typeof evaluateSkillSource>[0]["thread"] = sourceThread(),
  changedScriptIds: ReadonlyArray<string> = [],
) => ({
  candidateProjectId: project,
  thread,
  latestInputEventSequence: 5,
  checks: checksResult(record, changedScriptIds),
  expected: { attemptId, revision: 2, receiptSequence: 40 },
});

const sourceReason = (args: Parameters<typeof evaluateSkillSource>[0]): string => {
  const result = evaluateSkillSource(args);
  return result.ok ? "unexpectedly accepted" : result.reason;
};

const windowArgs = (
  receipt: SelectedCheckReceipt,
  nextInputEventSequence: number | null,
  overrides: {
    input?: Partial<ProjectSkillInputObservation>;
    sequence?: number;
    threadRecreatedAfterInput?: boolean;
  } = {},
) => ({
  input: inputObservation(overrides.input),
  receipt: { receipt, sequence: overrides.sequence ?? 40 },
  threadRecreatedAfterInput: overrides.threadRecreatedAfterInput ?? false,
  nextInputEventSequence,
});

const windowReason = (args: Parameters<typeof evaluateSkillUseWindow>[0]): string => {
  const result = evaluateSkillUseWindow(args);
  return result.ok ? "unexpectedly accepted" : result.reason;
};

type AdmissionVersion = Parameters<typeof evaluateProjectSkillAdmission>[0]["versions"][number];

const serverVersion = (
  overrides: {
    ref?: ProjectSkillVersionRef;
    state?: "candidate" | "active" | "retired";
    ready?: boolean;
    gaps?: ProjectSkillReadinessGap[];
  } = {},
): AdmissionVersion => ({
  ref: overrides.ref ?? refV1,
  state: overrides.state ?? "active",
  content: skillContent(),
  useReadiness: { ready: overrides.ready ?? true, gaps: overrides.gaps ?? [] },
});

const admissionArgs = (
  items: ReadonlyArray<{ contextId: string; payload: unknown }>,
  versions: ReadonlyArray<AdmissionVersion>,
  messageText: string,
) => ({ projectId: project, messageText, items, versions });

const skillItem = (contextId: string, ref: ProjectSkillVersionRef, mode: ProjectSkillMode) => ({
  contextId,
  payload: { ref, mode },
});

const messageWith = (blocks: ReadonlyArray<string>): string =>
  ["Please work on the release.", ...blocks, "Report back when done."].join("\n\n");

const expectAdmissionHold = (
  args: Parameters<typeof evaluateProjectSkillAdmission>[0],
  hold: string,
  contextId: string,
) => {
  const result = evaluateProjectSkillAdmission(args);
  expect(result.ok, contextId).toBe(false);
  if (!result.ok) {
    expect(result.hold, contextId).toBe(hold);
    expect(result.contextId, contextId).toBe(contextId);
  }
};

describe("project skill observation fixtures", () => {
  it("decodes the hand-written fixtures through the shared schemas", () => {
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(ProjectSkillInputObservation)(inputObservation())),
    ).toBe(true);
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(ProjectSkillCheckObservation)(passingReceipt())),
    ).toBe(false);
  });

  it("derives the success fixture as all-selected-passed before any window claim", () => {
    expect(deriveSelectedCheckState(recordAt(40))).toEqual({
      state: "all-selected-passed",
      reasons: [],
    });
  });
});

describe("evaluateSkillSource", () => {
  it("accepts the exact observed write as a historical source observation", () => {
    const result = evaluateSkillSource(sourceInput(recordAt(40)));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.check).toEqual({
      threadId: thread,
      threadAnchorSequence: 20,
      receiptSequence: 40,
      attemptId,
      revision: 2,
      projectId: project,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      cwd: "/tmp/workspace",
      envSha256: sha256,
      planned: passingReceipt().planned,
      tree: { treeOid, repoTopLevel: "/tmp/workspace", repoCommonDir: "/tmp/workspace" },
      environment: passingReceipt().environment,
      startedAt: "2026-08-20T12:00:00Z",
      endedAt: "2026-08-20T12:01:00Z",
      outcome: "all-selected-passed",
    });
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(ProjectSkillCheckObservation)(result.check)),
    ).toBe(true);
  });

  it("rejects a missing or malformed record before reading any receipt", () => {
    expect(sourceReason(sourceInput({ kind: "none" }))).toBe("no-record");
    expect(sourceReason(sourceInput({ kind: "malformed" }))).toBe("record-malformed");
  });

  it("rejects a record whose receipt names another thread", () => {
    expect(
      sourceReason(sourceInput(recordAt(40), { ...sourceThread(), threadId: otherThread })),
    ).toBe("record-malformed");
  });

  it("rejects a cancelled or otherwise unproven attempt with the derivation's reasons", () => {
    const cancelled = evaluateSkillSource(
      sourceInput(recordAt(40, { ...passingReceipt(), phase: "cancelled" })),
    );
    expect(cancelled).toMatchObject({ ok: false, reason: "not-all-selected-passed" });
    if (!cancelled.ok) expect(cancelled.detail.length).toBeGreaterThan(0);
  });

  it("rejects unless attempt, revision, and record row sequence all match the expected write", () => {
    const args = sourceInput(recordAt(40));
    expect(
      sourceReason({
        ...args,
        expected: { attemptId: "attempt-2", revision: 2, receiptSequence: 40 },
      }),
    ).toBe("observation-changed");
    expect(
      sourceReason({ ...args, expected: { attemptId, revision: 3, receiptSequence: 40 } }),
    ).toBe("observation-changed");
    expect(
      sourceReason({ ...args, expected: { attemptId, revision: 2, receiptSequence: 41 } }),
    ).toBe("observation-changed");
  });

  it("rejects a still-running turn", () => {
    expect(
      sourceReason(sourceInput(recordAt(40), { ...sourceThread(), latestTurnState: "running" })),
    ).toBe("turn-running");
  });

  it("rejects once any user input landed at or after the attempt's first receipt write", () => {
    expect(sourceReason({ ...sourceInput(recordAt(40)), latestInputEventSequence: 20 })).toBe(
      "input-after-checks",
    );
    expect(sourceReason({ ...sourceInput(recordAt(40)), latestInputEventSequence: 25 })).toBe(
      "input-after-checks",
    );
  });

  it("rejects project and worktree drift between the receipt and the thread", () => {
    expect(
      sourceReason(sourceInput(recordAt(40), { ...sourceThread(), projectId: otherProject })),
    ).toBe("project-mismatch");
    expect(sourceReason({ ...sourceInput(recordAt(40)), candidateProjectId: otherProject })).toBe(
      "project-mismatch",
    );
    expect(
      sourceReason(sourceInput(recordAt(40), { ...sourceThread(), worktreePath: "/tmp/worktree" })),
    ).toBe("worktree-changed");
  });

  it("rejects when a check command changed after the run", () => {
    expect(sourceReason(sourceInput(recordAt(40), sourceThread(), ["lint"]))).toBe(
      "check-commands-changed",
    );
  });

  it("applies the fixed gate order: the derived state wins over later gates", () => {
    const args = sourceInput(recordAt(40, { ...passingReceipt(), phase: "cancelled" }));
    expect(
      sourceReason({
        ...args,
        thread: { ...sourceThread(), latestTurnState: "running" },
        latestInputEventSequence: 100,
        expected: { attemptId: "attempt-9", revision: 9, receiptSequence: 99 },
      }),
    ).toBe("not-all-selected-passed");
  });
});

describe("evaluateSkillUseWindow", () => {
  it("admits a passed receipt wholly inside the input's window", () => {
    const result = evaluateSkillUseWindow(windowArgs(passingReceipt(), 100));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.check.outcome).toBe("all-selected-passed");
    expect(result.check.tree).toEqual({
      treeOid,
      repoTopLevel: "/tmp/workspace",
      repoCommonDir: "/tmp/workspace",
    });
    expect(result.check.threadAnchorSequence).toBe(20);
    expect(result.check.receiptSequence).toBe(40);
    expect(result.check.endedAt).toBe("2026-08-20T12:01:00Z");
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(ProjectSkillCheckObservation)(result.check)),
    ).toBe(true);
  });

  it("keeps the window open while no next user input exists", () => {
    expect(evaluateSkillUseWindow(windowArgs(passingReceipt(), null)).ok).toBe(true);
    expect(evaluateSkillUseWindow(windowArgs(passingReceipt(), 41)).ok).toBe(true);
  });

  it("admits a failed receipt with no tree claim and no fabricated end time", () => {
    const failed = passedCheck("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z");
    const receipt: SelectedCheckReceipt = {
      ...passingReceipt(),
      checks: [{ ...failed, status: "failed", exitCode: 2, group: "killed" }],
      endedAt: null,
    };
    const result = evaluateSkillUseWindow(windowArgs(receipt, null));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.check.outcome).toBe("failed");
    expect(result.check.tree).toBeNull();
    expect(result.check.endedAt).toBeNull();
    expect(
      Exit.isSuccess(Schema.decodeUnknownExit(ProjectSkillCheckObservation)(result.check)),
    ).toBe(true);
  });

  it("rejects a receipt bound to another thread or project", () => {
    expect(
      windowReason(windowArgs(passingReceipt(), 100, { input: { threadId: otherThread } })),
    ).toBe("different-thread");
    expect(
      windowReason(windowArgs(passingReceipt(), 100, { input: { projectId: otherProject } })),
    ).toBe("different-project");
  });

  it("rejects a thread recreated after the input on trusted event evidence, not the anchor", () => {
    expect(
      windowReason(windowArgs(passingReceipt(), 100, { threadRecreatedAfterInput: true })),
    ).toBe("thread-recreated");
  });

  it("rejects a missing or out-of-order anchor as fail-closed", () => {
    expect(windowReason(windowArgs({ ...passingReceipt(), threadAnchorSequence: null }, 100))).toBe(
      "anchor-missing",
    );
    expect(windowReason(windowArgs({ ...passingReceipt(), threadAnchorSequence: 50 }, 100))).toBe(
      "anchor-missing",
    );
  });

  it("rejects an attempt whose first write is at or before the input", () => {
    expect(
      windowReason(windowArgs(passingReceipt(), 100, { input: { inputEventSequence: 20 } })),
    ).toBe("attempt-before-input");
    expect(
      windowReason(windowArgs(passingReceipt(), 100, { input: { inputEventSequence: 25 } })),
    ).toBe("attempt-before-input");
  });

  it("rejects a terminal write at or after the next input, even with the anchor inside", () => {
    // Anchor 20 < next input 30, but the terminal write row 40 is not: this
    // attempt must never read as this input's result.
    expect(windowReason(windowArgs(passingReceipt(), 30))).toBe("attempt-after-next-input");
    expect(windowReason(windowArgs(passingReceipt(), 40))).toBe("attempt-after-next-input");
  });

  it("rejects a running or unproven outcome without consulting a clock", () => {
    expect(windowReason(windowArgs({ ...passingReceipt(), phase: "running" }, 100))).toBe(
      "outcome-incomplete",
    );
    expect(windowReason(windowArgs({ ...passingReceipt(), phase: "interrupted" }, 100))).toBe(
      "outcome-incomplete",
    );
  });
});

describe("evaluateProjectSkillAdmission", () => {
  it("admits plain text with no managed items, even when a block string is present", () => {
    expect(evaluateProjectSkillAdmission(admissionArgs([], [], messageWith([])))).toEqual({
      ok: true,
      admitted: [],
    });
    const block = renderProjectSkillBlock({ ref: refV1, content: skillContent(), mode: "use" });
    expect(
      evaluateProjectSkillAdmission(admissionArgs([], [serverVersion({})], messageWith([block]))),
    ).toEqual({ ok: true, admitted: [] });
  });

  it("admits one use-mode item from an active, ready version and its block", () => {
    const block = renderProjectSkillBlock({ ref: refV1, content: skillContent(), mode: "use" });
    const result = evaluateProjectSkillAdmission(
      admissionArgs(
        [{ contextId: "ctx-1", payload: { ref: refV1, mode: "use", admittedSkillStateSeq: 999 } }],
        [serverVersion({})],
        messageWith([block]),
      ),
    );
    // The client-sent admittedSkillStateSeq is ignored, not copied through.
    expect(result).toEqual({ ok: true, admitted: [{ ref: refV1, mode: "use" }] });
  });

  it("admits one trial-mode item from a candidate version", () => {
    const block = renderProjectSkillBlock({ ref: refV2, content: skillContent(), mode: "trial" });
    const result = evaluateProjectSkillAdmission(
      admissionArgs(
        [skillItem("ctx-2", refV2, "trial")],
        [serverVersion({ ref: refV2, state: "candidate" })],
        messageWith([block]),
      ),
    );
    expect(result).toEqual({ ok: true, admitted: [{ ref: refV2, mode: "trial" }] });
  });

  it("admits several items in order when each binds its own version and block", () => {
    const useBlock = renderProjectSkillBlock({ ref: refV1, content: skillContent(), mode: "use" });
    const trialBlock = renderProjectSkillBlock({
      ref: refV2,
      content: skillContent(),
      mode: "trial",
    });
    const result = evaluateProjectSkillAdmission(
      admissionArgs(
        [skillItem("ctx-1", refV1, "use"), skillItem("ctx-2", refV2, "trial")],
        [serverVersion({}), serverVersion({ ref: refV2, state: "candidate" })],
        messageWith([useBlock, trialBlock]),
      ),
    );
    expect(result).toEqual({
      ok: true,
      admitted: [
        { ref: refV1, mode: "use" },
        { ref: refV2, mode: "trial" },
      ],
    });
  });

  it("rejects a payload that does not decode as the context kind's payload", () => {
    expectAdmissionHold(
      admissionArgs([{ contextId: "ctx-bad", payload: { nope: true } }], [serverVersion({})], ""),
      "malformed-item",
      "ctx-bad",
    );
  });

  it("rejects a repeated contextId and a repeated ref", () => {
    const block = renderProjectSkillBlock({ ref: refV1, content: skillContent(), mode: "use" });
    expectAdmissionHold(
      admissionArgs(
        [
          { contextId: "ctx-1", payload: { ref: refV1, mode: "use" } },
          { contextId: "ctx-1", payload: { ref: refV2, mode: "use" } },
        ],
        [serverVersion({})],
        messageWith([block]),
      ),
      "duplicate-item",
      "ctx-1",
    );
    const trialBlock = renderProjectSkillBlock({
      ref: refV2,
      content: skillContent(),
      mode: "trial",
    });
    expectAdmissionHold(
      admissionArgs(
        [skillItem("ctx-1", refV2, "trial"), skillItem("ctx-2", refV2, "trial")],
        [serverVersion({ ref: refV2, state: "candidate" })],
        messageWith([trialBlock]),
      ),
      "duplicate-item",
      "ctx-2",
    );
  });

  it("rejects a record bound to another project", () => {
    expectAdmissionHold(
      admissionArgs([skillItem("ctx-3", { ...refV1, projectId: otherProject }, "use")], [], ""),
      "project-mismatch",
      "ctx-3",
    );
  });

  it("rejects a version the server does not have, separating missing from stale content", () => {
    expectAdmissionHold(
      admissionArgs(
        [skillItem("ctx-4", { ...refV1, skillId: ProjectSkillId.make("psk_zzzz9999") }, "use")],
        [serverVersion({})],
        "",
      ),
      "version-missing",
      "ctx-4",
    );
    // Same project, skill, and version number, different content hash.
    expectAdmissionHold(
      admissionArgs(
        [skillItem("ctx-5", { ...refV1, contentSha256: otherSha256 }, "use")],
        [serverVersion({})],
        "",
      ),
      "content-mismatch",
      "ctx-5",
    );
  });

  it("separates the use gates: not-active and not-ready", () => {
    const block = renderProjectSkillBlock({ ref: refV1, content: skillContent(), mode: "use" });
    expectAdmissionHold(
      admissionArgs(
        [skillItem("ctx-6", refV1, "use")],
        [serverVersion({ state: "candidate" })],
        messageWith([block]),
      ),
      "not-active",
      "ctx-6",
    );
    expectAdmissionHold(
      admissionArgs(
        [skillItem("ctx-7", refV1, "use")],
        [serverVersion({ ready: false, gaps: ["rights-unreviewed"] })],
        messageWith([block]),
      ),
      "not-ready",
      "ctx-7",
    );
  });

  it("rejects a trial record on a version that is not a candidate", () => {
    const block = renderProjectSkillBlock({ ref: refV1, content: skillContent(), mode: "trial" });
    expectAdmissionHold(
      admissionArgs(
        [skillItem("ctx-8", refV1, "trial")],
        [serverVersion({ state: "active" })],
        messageWith([block]),
      ),
      "not-candidate",
      "ctx-8",
    );
  });

  it("rejects an edited, duplicated, or absent block", () => {
    const block = renderProjectSkillBlock({ ref: refV1, content: skillContent(), mode: "use" });
    const edited = `${block.slice(0, -1)}?`;
    expectAdmissionHold(
      admissionArgs([skillItem("ctx-9", refV1, "use")], [serverVersion({})], messageWith([edited])),
      "block-missing-or-altered",
      "ctx-9",
    );
    expectAdmissionHold(
      admissionArgs(
        [skillItem("ctx-10", refV1, "use")],
        [serverVersion({})],
        messageWith([block, block]),
      ),
      "block-missing-or-altered",
      "ctx-10",
    );
    expectAdmissionHold(
      admissionArgs([skillItem("ctx-11", refV1, "use")], [serverVersion({})], messageWith([])),
      "block-missing-or-altered",
      "ctx-11",
    );
  });
});
