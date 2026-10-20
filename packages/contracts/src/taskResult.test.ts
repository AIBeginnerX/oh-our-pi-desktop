import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CommandId, EnvironmentId, EventId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ClientOrchestrationCommand } from "./orchestration.ts";
import {
  SELECTED_CHECK_MAX,
  SERVER_RECORD_ACTIVITY_KINDS,
  SelectedCheckReceipt,
  SelectedCheckResult,
  SelectedChecksGetResult,
  TASK_RESULT_ACTIVITY_KIND,
  taskResultRecordId,
} from "./selectedChecks.ts";
import {
  TASK_RESULT_ITEMS_MAX,
  TaskResultAcceptInput,
  TaskResultGetResult,
  TaskResultRecord,
  TaskResultRejectedError,
  TaskResultSetRequirementsInput,
  TaskResultThreadNotFoundError,
  TaskResultWithdrawInput,
  deriveTaskResultState,
  validateTaskResultItems,
} from "./taskResult.ts";

const sha256 = "a".repeat(64);
const changedSha256 = "9".repeat(64);
const treeOid = "b".repeat(40);

const thread = ThreadId.make("thread-1");
const project = ProjectId.make("project-1");
const environment = EnvironmentId.make("env-1");
const attemptId = "attempt-1";

/** The thread's latest `thread.created` sequence: the current incarnation. */
const INCARNATION = 5;
/** The attempt's first write — strictly after the create event that began this incarnation. */
const ANCHOR_SEQUENCE = 6;
/** The event row holding the latest stored receipt. */
const RECEIPT_SEQUENCE = 7;
const RECORD_SEQUENCE = 9;

const passedResult = (
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

const failedResult = (
  scriptId: string,
  exitCode: number | null,
  startedAt: string,
  endedAt: string,
): SelectedCheckResult => ({
  ...passedResult(scriptId, startedAt, endedAt),
  status: "failed",
  exitCode,
  group: "killed",
});

const plannedLint = {
  scriptId: "lint",
  scriptName: "Lint",
  commandSha256: sha256,
  timeoutMs: 60_000,
};
const plannedTest = {
  scriptId: "test",
  scriptName: "Test",
  commandSha256: "f".repeat(64),
  timeoutMs: 60_000,
};

/**
 * A receipt of the exact shape a completed, fully proven attempt writes.
 * Hand-written like the selected-checks fixture: it proves the schema and
 * the judgment agree, never that a server executed anything.
 */
const receipt = (overrides: Partial<SelectedCheckReceipt> = {}): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId: thread,
  attemptId,
  revision: 2,
  threadAnchorSequence: ANCHOR_SEQUENCE,
  context: {
    projectId: project,
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    cwd: "/tmp/workspace",
    shell: "/bin/zsh",
    envSha256: sha256,
  },
  planned: [plannedLint, plannedTest],
  environment: {
    environmentId: environment,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "22.11.0",
  },
  tree: {
    atStart: { kind: "complete", treeOid },
    atEnd: { kind: "complete", treeOid },
    repoAtStart: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace/.git" },
    repoAtEnd: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace/.git" },
  },
  phase: "completed",
  checks: [
    passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
    passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
  ],
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: "2026-08-20T12:01:00Z",
  error: null,
  ...overrides,
});

const requirementItems = (): Array<{
  id: string;
  text: string;
  scriptIds: Array<string>;
}> => [
  { id: "req-lint", text: "Lint stays clean", scriptIds: ["lint"] },
  { id: "req-docs", text: "Docs explain the change", scriptIds: [] },
];

const requirements = (
  overrides: Partial<NonNullable<TaskResultRecord["requirements"]>> = {},
): NonNullable<TaskResultRecord["requirements"]> => ({
  version: 1,
  items: requirementItems(),
  checks: [{ scriptId: "lint", commandSha256: sha256 }],
  setAt: "2026-08-20T11:00:00Z",
  ...overrides,
});

const acceptance = (
  overrides: Partial<NonNullable<TaskResultRecord["acceptance"]>> = {},
): NonNullable<TaskResultRecord["acceptance"]> => ({
  requirementsVersion: 1,
  checkAttemptId: attemptId,
  checkReceiptSequence: RECEIPT_SEQUENCE,
  acceptedAt: "2026-08-20T12:30:00Z",
  ...overrides,
});

const taskRecord = (overrides: Partial<TaskResultRecord> = {}): TaskResultRecord => ({
  schemaVersion: 1,
  threadId: thread,
  revision: 3,
  threadIncarnation: INCARNATION,
  requirements: requirements(),
  acceptance: null,
  ...overrides,
});

const checksResult = (
  overrides: Partial<SelectedChecksGetResult> = {},
): SelectedChecksGetResult => ({
  capability: { available: true, reason: null },
  record: { kind: "present", receipt: receipt(), sequence: RECEIPT_SEQUENCE },
  changedScriptIds: [],
  admission: { state: "open" },
  treeUnchanged: true,
  environmentMatches: true,
  contextMatches: true,
  ...overrides,
});

const getResult = (overrides: Partial<TaskResultGetResult> = {}): TaskResultGetResult => ({
  record: { kind: "present", record: taskRecord(), sequence: RECORD_SEQUENCE },
  threadIncarnation: INCARNATION,
  checks: checksResult(),
  ...overrides,
});

const presentRecord = (record: TaskResultRecord): TaskResultGetResult["record"] => ({
  kind: "present",
  record,
  sequence: RECORD_SEQUENCE,
});

const acceptedRecord = (overrides: Partial<TaskResultRecord> = {}): TaskResultGetResult["record"] =>
  presentRecord(taskRecord({ acceptance: acceptance(), ...overrides }));

describe("task result constants", () => {
  it("names the server record, derives its per-thread id, and registers the kind", () => {
    expect(TASK_RESULT_ACTIVITY_KIND).toBe("task-result");
    expect(taskResultRecordId(thread)).toBe("task-result:thread-1");
    expect(SERVER_RECORD_ACTIVITY_KINDS).toContain(TASK_RESULT_ACTIVITY_KIND);
  });

  it("cannot be written through the client command union", () => {
    const decoded = Schema.decodeUnknownExit(ClientOrchestrationCommand)({
      type: "thread.activity.append",
      commandId: CommandId.make("command-1"),
      threadId: thread,
      activity: {
        id: EventId.make(taskResultRecordId(thread)),
        tone: "info",
        kind: TASK_RESULT_ACTIVITY_KIND,
        summary: "forged",
        payload: { forged: true },
        turnId: null,
        createdAt: "2026-08-20T12:00:00Z",
      },
      createdAt: "2026-08-20T12:00:00Z",
    });
    expect(Exit.isFailure(decoded)).toBe(true);
  });
});

describe("validateTaskResultItems", () => {
  it("accepts a bounded list with unique ids and at least one bound check", () => {
    expect(validateTaskResultItems(requirementItems())).toEqual([]);
    expect(
      validateTaskResultItems(
        Array.from({ length: TASK_RESULT_ITEMS_MAX }, (_, index) => ({
          id: `req-${index}`,
          text: `Requirement ${index}`,
          scriptIds: index === 0 ? ["lint", "test"] : [],
        })),
      ),
    ).toEqual([]);
  });

  it("rejects empty, oversized, duplicated, and checkless requirements", () => {
    expect(validateTaskResultItems([])).toEqual(["the requirements hold no items"]);
    expect(
      validateTaskResultItems(
        Array.from({ length: TASK_RESULT_ITEMS_MAX + 1 }, (_, index) => ({
          id: `req-${index}`,
          text: `Requirement ${index}`,
          scriptIds: index === 0 ? ["lint"] : [],
        })),
      ),
    ).toEqual([`the requirements hold more than ${TASK_RESULT_ITEMS_MAX} items`]);
    expect(
      validateTaskResultItems([
        { id: "req-a", text: "a", scriptIds: ["lint"] },
        { id: "req-a", text: "b", scriptIds: ["test"] },
      ]),
    ).toEqual(["requirement 'req-a' is listed more than once"]);
    expect(
      validateTaskResultItems([
        { id: "req-a", text: "a", scriptIds: ["lint"] },
        { id: "req-b", text: "b", scriptIds: ["lint"] },
      ]),
    ).toEqual(["script 'lint' is bound to requirements more than once"]);
    expect(validateTaskResultItems([{ id: "req-a", text: "a", scriptIds: [] }])).toEqual([
      "no requirement binds a check",
    ]);
    expect(
      validateTaskResultItems([
        { id: "req-a", text: "a", scriptIds: Array.from({ length: 11 }, (_, i) => `c-${i}`) },
      ]),
    ).toEqual([`requirements bind more than ${SELECTED_CHECK_MAX} checks`]);
  });
});

describe("TaskResultRecord", () => {
  const decode = Schema.decodeUnknownExit(TaskResultRecord);

  it("decodes a record with requirements and acceptance, and the get result wraps it", () => {
    expect(Exit.isSuccess(decode(taskRecord({ acceptance: acceptance() })))).toBe(true);
    expect(Exit.isSuccess(Schema.decodeUnknownExit(TaskResultGetResult)(getResult()))).toBe(true);
  });

  it("rejects wrong versions, unsafe counters, and incarnation drift", () => {
    for (const value of [
      { ...taskRecord(), schemaVersion: 2 },
      { ...taskRecord(), revision: -1 },
      { ...taskRecord(), revision: 2 ** 53 },
      { ...taskRecord(), threadIncarnation: -1 },
      { ...taskRecord(), acceptance: { ...acceptance(), requirementsVersion: 0 } },
      { ...taskRecord(), acceptance: { ...acceptance(), checkReceiptSequence: -1 } },
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });

  it("rejects requirements whose pinned checks are not exactly the bound scripts", () => {
    // A pinned check no item binds, and a bound script with no pinned check,
    // are both rejected — never silently trimmed into agreement.
    const extraPinned = taskRecord({
      requirements: requirements({
        checks: [
          { scriptId: "lint", commandSha256: sha256 },
          { scriptId: "test", commandSha256: "f".repeat(64) },
        ],
      }),
    });
    expect(Exit.isFailure(decode(extraPinned))).toBe(true);
    const underPinned = taskRecord({
      requirements: requirements({
        items: [
          { id: "req-lint", text: "Lint", scriptIds: ["lint"] },
          { id: "req-test", text: "Test", scriptIds: ["test"] },
        ],
      }),
    });
    expect(Exit.isFailure(decode(underPinned))).toBe(true);
    const emptyPinned = taskRecord({ requirements: requirements({ checks: [] }) });
    expect(Exit.isFailure(decode(emptyPinned))).toBe(true);
    const duplicatePinned = taskRecord({
      requirements: requirements({
        items: [{ id: "req-lint", text: "Lint", scriptIds: ["lint"] }],
        checks: [
          { scriptId: "lint", commandSha256: sha256 },
          { scriptId: "lint", commandSha256: sha256 },
        ],
      }),
    });
    expect(Exit.isFailure(decode(duplicatePinned))).toBe(true);
  });
});

describe("task result mutation inputs", () => {
  it("carry the incarnation and revision CAS guard on every mutation", () => {
    const set = Schema.decodeUnknownSync(TaskResultSetRequirementsInput)({
      threadId: thread,
      threadIncarnation: INCARNATION,
      expectedRevision: null,
      items: requirementItems(),
    });
    expect(set.threadId).toBe(thread);
    expect(set.threadIncarnation).toBe(INCARNATION);
    expect(set.expectedRevision).toBeNull();
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(TaskResultSetRequirementsInput)({
          threadId: thread,
          threadIncarnation: INCARNATION,
          expectedRevision: 3,
          items: requirementItems(),
        }),
      ),
    ).toBe(true);
  });

  it("rejects missing or unsafe CAS fields", () => {
    const decode = Schema.decodeUnknownExit(TaskResultSetRequirementsInput);
    for (const value of [
      { threadId: thread, expectedRevision: null, items: requirementItems() },
      {
        threadId: thread,
        threadIncarnation: -1,
        expectedRevision: null,
        items: requirementItems(),
      },
      {
        threadId: thread,
        threadIncarnation: INCARNATION,
        expectedRevision: -1,
        items: requirementItems(),
      },
      { threadId: thread, threadIncarnation: INCARNATION, items: requirementItems() },
      {
        threadId: thread,
        threadIncarnation: INCARNATION,
        expectedRevision: null,
        items: [{ id: "req-a", text: "a", scriptIds: [] }],
      },
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });

  it("binds acceptance to the exact requirements version, attempt, and receipt row", () => {
    const accept = {
      threadId: thread,
      threadIncarnation: INCARNATION,
      expectedRevision: 3,
      requirementsVersion: 1,
      checkAttemptId: attemptId,
      checkReceiptSequence: RECEIPT_SEQUENCE,
    };
    expect(Schema.decodeUnknownSync(TaskResultAcceptInput)(accept).checkReceiptSequence).toBe(
      RECEIPT_SEQUENCE,
    );
    for (const value of [
      { ...accept, requirementsVersion: 0 },
      { ...accept, checkAttemptId: "   " },
      { ...accept, checkReceiptSequence: -1 },
      { threadId: thread, threadIncarnation: INCARNATION, expectedRevision: 3 },
    ]) {
      expect(Exit.isFailure(Schema.decodeUnknownExit(TaskResultAcceptInput)(value))).toBe(true);
    }
  });

  it("withdraws under the same CAS guard without a requirements version", () => {
    const decode = Schema.decodeUnknownExit(TaskResultWithdrawInput);
    expect(
      Exit.isSuccess(
        decode({ threadId: thread, threadIncarnation: INCARNATION, expectedRevision: 3 }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(decode({ threadId: thread, threadIncarnation: -1, expectedRevision: 3 })),
    ).toBe(true);
  });
});

describe("task result errors", () => {
  it("names its rejection reason and detail", () => {
    expect(new TaskResultRejectedError({ reason: "conflict" }).message).toBe(
      "Task result rejected: conflict",
    );
    expect(
      new TaskResultRejectedError({ reason: "conflict", detail: "record is at revision 4" })
        .message,
    ).toBe("Task result rejected: conflict (record is at revision 4)");
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(TaskResultRejectedError)({
          _tag: "TaskResultRejectedError",
          reason: "mystery",
        }),
      ),
    ).toBe(true);
  });

  it("carries the missing thread id", () => {
    expect(new TaskResultThreadNotFoundError({ threadId: thread }).message).toBe(
      "Thread 'thread-1' does not exist.",
    );
  });
});

describe("deriveTaskResultState", () => {
  it("reads no record and no requirements as no-requirements, even while a turn runs", () => {
    expect(deriveTaskResultState(getResult({ record: { kind: "none" } }), true)).toEqual({
      state: "no-requirements",
      acceptance: "none",
      reasons: [],
      items: [],
    });
    expect(
      deriveTaskResultState(
        getResult({ record: presentRecord(taskRecord({ requirements: null })) }),
        false,
      ),
    ).toEqual({ state: "no-requirements", acceptance: "none", reasons: [], items: [] });
    expect(deriveTaskResultState(getResult({ record: { kind: "malformed" } }), false)).toEqual({
      state: "needs-confirmation",
      acceptance: "none",
      reasons: ["the stored record is malformed"],
      items: [],
    });
  });

  it("reads a fully current read without acceptance as awaiting-acceptance", () => {
    expect(deriveTaskResultState(getResult(), false)).toEqual({
      state: "awaiting-acceptance",
      acceptance: "none",
      reasons: [],
      items: [
        { id: "req-lint", status: "checked" },
        { id: "req-docs", status: "user-judged" },
      ],
    });
  });

  it("reads a matching stored acceptance over a fully current read as verified", () => {
    expect(deriveTaskResultState(getResult({ record: acceptedRecord() }), false)).toEqual({
      state: "verified",
      acceptance: "current",
      reasons: [],
      items: [
        { id: "req-lint", status: "checked" },
        { id: "req-docs", status: "user-judged" },
      ],
    });
  });

  it("does not veto readiness on a structurally clean failure of a check no requirement pins", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            checks: [
              passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              // A valid window, complete digests and an empty group — only the
              // exit itself differs, and 'test' is not a required check.
              {
                ...passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
                status: "failed",
                exitCode: 1,
              },
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("awaiting-acceptance");
    expect(derived.reasons).toEqual([]);
    expect(derived.items[0]).toEqual({ id: "req-lint", status: "checked" });
  });

  it("still needs confirmation when an unpinned check's own window is malformed", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            checks: [
              passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              {
                ...passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
                startedAt: null,
                endedAt: null,
              },
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain(
      "'test' has an invalid window: the start timestamp is missing",
    );
    expect(derived.items[0]).toEqual({ id: "req-lint", status: "unproven" });
  });

  it("reads a current required failure as failed ahead of a still-running attempt", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            phase: "running",
            checks: [
              failedResult("lint", 2, "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              {
                ...passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
                status: "running",
              },
            ],
            endedAt: null,
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("failed");
    expect(derived.reasons).toEqual(["required check 'lint' exited 2"]);
    expect(derived.items[0]).toEqual({ id: "req-lint", status: "unproven" });
  });

  it("does not promote a failure the attempt ran under a different command than pinned", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            planned: [{ ...plannedLint, commandSha256: changedSha256 }, plannedTest],
            checks: [
              failedResult("lint", 2, "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain(
      "required check 'lint' ran a command different from the one the requirement pins",
    );
  });

  it("does not promote a failure whose script changed since the attempt", () => {
    const result = getResult({
      checks: checksResult({
        changedScriptIds: ["lint"],
        record: {
          kind: "present",
          receipt: receipt({
            checks: [
              failedResult("lint", 2, "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain(
      "the command for required check 'lint' changed since the attempt",
    );
  });

  it("does not promote a failure without an observed exit code", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            checks: [
              failedResult("lint", null, "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain("'lint' was recorded as failed");
  });

  it("does not promote a required failure whose anchor is newer than its stored row", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            threadAnchorSequence: 8,
            checks: [
              failedResult("lint", 2, "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain("the record's event anchor is newer than the record itself");
  });

  it("does not promote a required failure whose result does not sit at its plan position", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            checks: [
              passedResult("test", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              failedResult("lint", 2, "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain("check 0 is 'test' where the plan has 'lint'");
  });

  it("needs confirmation instead of running when the attempt's plan is invalid", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({ phase: "running", planned: [], checks: [], endedAt: null }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain("the plan is invalid: the plan holds no checks");
  });

  it("needs confirmation when a required check is absent from the latest attempt's plan", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            planned: [plannedTest],
            checks: [passedResult("test", "2026-08-20T12:00:00Z", "2026-08-20T12:01:00Z")],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain("required check 'lint' was not in the latest attempt's plan");
    expect(derived.items[0]).toEqual({ id: "req-lint", status: "unproven" });
  });

  it("reads absent or null current observations as unknown, never a match", () => {
    const checks: SelectedChecksGetResult = {
      capability: { available: true, reason: null },
      record: { kind: "present", receipt: receipt(), sequence: RECEIPT_SEQUENCE },
      changedScriptIds: [],
      admission: { state: "open" },
    };
    const derived = deriveTaskResultState(getResult({ checks }), false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toEqual(
      expect.arrayContaining([
        "the current workspace tree was not measured",
        "the current environment was not compared to the attempt's",
        "the current execution context was not measured",
      ]),
    );
    // Explicit nulls read unknown the same way — never as matches.
    const nulled = deriveTaskResultState(
      getResult({
        checks: checksResult({
          treeUnchanged: null,
          environmentMatches: null,
          contextMatches: null,
        }),
      }),
      false,
    );
    expect(nulled.state).toBe("needs-confirmation");
  });

  it("reads a different environment or context as a mismatch, not a pass", () => {
    const otherEnvironment = deriveTaskResultState(
      getResult({ checks: checksResult({ environmentMatches: false }) }),
      false,
    );
    expect(otherEnvironment.state).toBe("needs-confirmation");
    expect(otherEnvironment.reasons).toContain(
      "the current environment differs from the attempt's environment",
    );
    const otherContext = deriveTaskResultState(
      getResult({ checks: checksResult({ contextMatches: false }) }),
      false,
    );
    expect(otherContext.state).toBe("needs-confirmation");
    expect(otherContext.reasons).toContain(
      "the current execution context differs from the attempt's",
    );
  });

  it("keeps a tuple-matching acceptance stale while any current observation fails", () => {
    const result = getResult({
      record: acceptedRecord(),
      checks: checksResult({ treeUnchanged: false }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.acceptance).toBe("stale");
    expect(derived.reasons).toContain("the workspace tree changed since the attempt observed it");
  });

  it("does not call a required check proven on evidence it rejected", () => {
    const invalidWindow = deriveTaskResultState(
      getResult({
        checks: checksResult({
          record: {
            kind: "present",
            receipt: receipt({
              checks: [
                {
                  ...passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
                  startedAt: "2026-08-20T12:00:30Z",
                  endedAt: "2026-08-20T12:00:00Z",
                },
                passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
              ],
            }),
            sequence: RECEIPT_SEQUENCE,
          },
        }),
      }),
      false,
    );
    expect(invalidWindow.state).toBe("needs-confirmation");
    expect(invalidWindow.items[0]).toEqual({ id: "req-lint", status: "unproven" });
    const changedTree = deriveTaskResultState(
      getResult({ checks: checksResult({ treeUnchanged: false }) }),
      false,
    );
    expect(changedTree.state).toBe("needs-confirmation");
    expect(changedTree.items[0]).toEqual({ id: "req-lint", status: "unproven" });
  });

  it("reads a requirements revision with cleared acceptance as none, not stale", () => {
    const result = getResult({
      record: presentRecord(
        taskRecord({ requirements: requirements({ version: 2 }), acceptance: null }),
      ),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("awaiting-acceptance");
    expect(derived.acceptance).toBe("none");
  });

  it("reads a stored acceptance for another requirements version as stale", () => {
    const result = getResult({
      record: presentRecord(
        taskRecord({
          requirements: requirements({ version: 2 }),
          acceptance: acceptance(),
        }),
      ),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("awaiting-acceptance");
    expect(derived.acceptance).toBe("stale");
  });

  it("reads an acceptance bound to a different receipt row of the same attempt as stale", () => {
    const result = getResult({
      record: acceptedRecord({ acceptance: acceptance({ checkReceiptSequence: 8 }) }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("awaiting-acceptance");
    expect(derived.acceptance).toBe("stale");
    const sameForAttempt = deriveTaskResultState(
      getResult({
        record: acceptedRecord({ acceptance: acceptance({ checkAttemptId: "attempt-2" }) }),
      }),
      false,
    );
    expect(sameForAttempt.acceptance).toBe("stale");
  });

  it("needs confirmation when the record belongs to a different thread incarnation", () => {
    const result = getResult({
      record: acceptedRecord({ threadIncarnation: 4 }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.acceptance).toBe("stale");
    expect(derived.reasons).toContain(
      "the record was written for a different incarnation of this thread",
    );
  });

  it("needs confirmation when the attempt predates the current incarnation, even observed failing", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            threadAnchorSequence: 4,
            checks: [
              failedResult("lint", 2, "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
              passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
            ],
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.reasons).toContain(
      "the recorded check attempt belongs to an earlier incarnation of this thread",
    );
  });

  it("needs confirmation when the receipt belongs to a different thread", () => {
    // A positive-looking receipt — tuple-matching acceptance and all — that
    // was written under another thread id is foreign history, not evidence.
    const result = getResult({
      record: acceptedRecord(),
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({ threadId: ThreadId.make("thread-2") }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.acceptance).toBe("stale");
    expect(derived.items[0]).toEqual({ id: "req-lint", status: "unproven" });
    expect(derived.reasons).toContain("the recorded check attempt belongs to a different thread");
  });

  it("fails closed when the current incarnation is unknown", () => {
    const { threadIncarnation: _threadIncarnation, ...result } = getResult({
      record: acceptedRecord(),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.acceptance).toBe("stale");
    expect(derived.reasons).toContain("the thread's current incarnation is unknown");
  });

  it("needs confirmation while a turn is in progress", () => {
    const derived = deriveTaskResultState(getResult({ record: acceptedRecord() }), true);
    expect(derived.state).toBe("needs-confirmation");
    expect(derived.acceptance).toBe("stale");
    expect(derived.reasons).toContain("a turn is in progress");
  });

  it("reads a current running attempt as running", () => {
    const result = getResult({
      checks: checksResult({
        record: {
          kind: "present",
          receipt: receipt({
            phase: "running",
            checks: [
              {
                ...passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
                status: "running",
                endedAt: null,
              },
              {
                ...passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
                status: "pending",
                startedAt: null,
                endedAt: null,
              },
            ],
            endedAt: null,
          }),
          sequence: RECEIPT_SEQUENCE,
        },
      }),
    });
    const derived = deriveTaskResultState(result, false);
    expect(derived.state).toBe("running");
    expect(derived.reasons).toEqual([]);
  });

  it("needs confirmation when the check record is absent or malformed", () => {
    const none = deriveTaskResultState(
      getResult({ checks: checksResult({ record: { kind: "none" } }) }),
      false,
    );
    expect(none.state).toBe("needs-confirmation");
    expect(none.reasons).toContain("no check attempt has been recorded");
    expect(none.items[0]).toEqual({ id: "req-lint", status: "unproven" });
    const malformed = deriveTaskResultState(
      getResult({ checks: checksResult({ record: { kind: "malformed" } }) }),
      false,
    );
    expect(malformed.state).toBe("needs-confirmation");
    expect(malformed.reasons).toContain("the stored check record is malformed");
  });

  it("reads a proven run plus withdrawn acceptance as awaiting-acceptance", () => {
    // Withdraw clears the stored acceptance: what remains is a fully current
    // read with nothing accepted.
    const derived = deriveTaskResultState(getResult(), false);
    expect(derived).toEqual({
      state: "awaiting-acceptance",
      acceptance: "none",
      reasons: [],
      items: [
        { id: "req-lint", status: "checked" },
        { id: "req-docs", status: "user-judged" },
      ],
    });
  });
});
