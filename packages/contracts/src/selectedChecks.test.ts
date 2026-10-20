import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { CommandId, EnvironmentId, EventId, ProjectId, ThreadId } from "./baseSchemas.ts";
import { ClientOrchestrationCommand } from "./orchestration.ts";
import { RELEASE_VERIFICATION_ACTIVITY_KIND } from "./releaseVerification.ts";
import {
  GitTreeOid,
  OWNED_USAGE_ACTIVITY_KIND,
  SELECTED_CHECK_MAX,
  SELECTED_CHECK_RECEIPT_KIND,
  SELECTED_CHECK_TIMEOUT_MS_MAX,
  SERVER_RECORD_ACTIVITY_KINDS,
  SelectedCheckAdmission,
  SelectedCheckPlannedCheck,
  SelectedCheckReceipt,
  SelectedCheckResult,
  SelectedChecksCancelInput,
  SelectedChecksCancelResult,
  SelectedChecksGetResult,
  SelectedChecksRejectedError,
  SelectedChecksResolveOwnershipInput,
  SelectedChecksResolveOwnershipResult,
  SelectedChecksRunInput,
  SelectedChecksRunResult,
  SelectedChecksThreadNotFoundError,
  SelectedCheckTimestamp,
  SelectedCheckTreeObservation,
  Sha256Hex,
  TASK_RESULT_ACTIVITY_KIND,
  deriveSelectedCheckState,
  parseSelectedCheckInstant,
  selectedCheckIntervalDisagreement,
  selectedCheckReceiptId,
  selectedCheckTreeDisagreement,
  validateSelectedCheckPlan,
} from "./selectedChecks.ts";

const sha256 = "a".repeat(64);
const treeOid40 = "b".repeat(40);
const treeOid64 = "c".repeat(64);

const plannedCheck = (
  overrides: Partial<SelectedCheckPlannedCheck> = {},
): SelectedCheckPlannedCheck => ({
  scriptId: "lint",
  scriptName: "Lint",
  commandSha256: sha256,
  timeoutMs: 60_000,
  ...overrides,
});

const completeTree = (treeOid = treeOid40): SelectedCheckTreeObservation => ({
  kind: "complete",
  treeOid,
});

describe("selected check constants", () => {
  it("names the server record and derives its per-thread id from the kind", () => {
    expect(SELECTED_CHECK_RECEIPT_KIND).toBe("selected-check-receipt");
    expect(selectedCheckReceiptId(ThreadId.make("thread-1"))).toBe(
      "selected-check-receipt:thread-1",
    );
  });

  it("lists the record kinds only the server writes", () => {
    expect(SERVER_RECORD_ACTIVITY_KINDS).toEqual([
      RELEASE_VERIFICATION_ACTIVITY_KIND,
      SELECTED_CHECK_RECEIPT_KIND,
      OWNED_USAGE_ACTIVITY_KIND,
      TASK_RESULT_ACTIVITY_KIND,
    ]);
  });

  it("names the owned-usage record kind the server ingestion writes", () => {
    expect(OWNED_USAGE_ACTIVITY_KIND).toBe("owned-usage");
  });

  it("bounds the plan size and per-check timeout", () => {
    expect(SELECTED_CHECK_MAX).toBe(10);
    expect(SELECTED_CHECK_TIMEOUT_MS_MAX).toBe(3_600_000);
  });
});

describe("Sha256Hex", () => {
  it("accepts exactly 64 lowercase hex characters", () => {
    expect(Schema.is(Sha256Hex)(sha256)).toBe(true);
    expect(Schema.is(Sha256Hex)("a".repeat(63))).toBe(false);
    expect(Schema.is(Sha256Hex)("a".repeat(65))).toBe(false);
    expect(Schema.is(Sha256Hex)("A".repeat(64))).toBe(false);
    expect(Schema.is(Sha256Hex)("g".repeat(64))).toBe(false);
    expect(Schema.is(Sha256Hex)(64)).toBe(false);
  });
});

describe("GitTreeOid", () => {
  it("accepts 40 or 64 lowercase hex characters and nothing else", () => {
    expect(Schema.is(GitTreeOid)(treeOid40)).toBe(true);
    expect(Schema.is(GitTreeOid)(treeOid64)).toBe(true);
    expect(Schema.is(GitTreeOid)("b".repeat(39))).toBe(false);
    expect(Schema.is(GitTreeOid)("b".repeat(41))).toBe(false);
    expect(Schema.is(GitTreeOid)("b".repeat(50))).toBe(false);
    expect(Schema.is(GitTreeOid)("B".repeat(40))).toBe(false);
  });
});

describe("SelectedCheckTimestamp", () => {
  const decode = Schema.decodeUnknownExit(SelectedCheckTimestamp);

  it("decodes real instants and normalizes differing offsets", () => {
    const utc = Schema.decodeUnknownSync(SelectedCheckTimestamp)("2026-08-20T12:00:00.000Z");
    const shifted = Schema.decodeUnknownSync(SelectedCheckTimestamp)("2026-08-20T14:00:00+02:00");
    expect(DateTime.toEpochMillis(utc)).toBe(DateTime.toEpochMillis(shifted));
    expect(Exit.isSuccess(decode("2024-02-29T00:00:00Z"))).toBe(true);
  });

  it("rejects strings that are not real instants", () => {
    for (const value of [
      "",
      "not a date",
      "2026-13-45T25:61:61Z",
      "yesterday at noon",
      // Invalid calendars must fail, not roll forward into a different instant.
      "2026-02-29T00:00:00Z",
      "2026-02-30T00:00:00Z",
      "2026-04-31T00:00:00Z",
      // No explicit offset means the string does not name an instant at all.
      "2026-01-01",
      "2026-01-01T12:00:00",
      "2026-01-01T12:00:00+24:00",
      "01/02/2026",
      42,
      null,
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });
});

describe("SelectedCheckPlannedCheck", () => {
  const decode = Schema.decodeUnknownExit(SelectedCheckPlannedCheck);

  it("accepts a fully described check at the timeout bounds", () => {
    expect(Exit.isSuccess(decode(plannedCheck({ timeoutMs: 1 })))).toBe(true);
    expect(Exit.isSuccess(decode(plannedCheck({ timeoutMs: SELECTED_CHECK_TIMEOUT_MS_MAX })))).toBe(
      true,
    );
    const decoded = Schema.decodeUnknownSync(SelectedCheckPlannedCheck)(
      plannedCheck({ scriptId: "  typecheck  " }),
    );
    expect(decoded.scriptId).toBe("typecheck");
  });

  it("rejects missing or out-of-range fields", () => {
    for (const value of [
      plannedCheck({ scriptId: "" }),
      plannedCheck({ scriptId: "   " }),
      plannedCheck({ scriptName: "x".repeat(81) }),
      plannedCheck({ commandSha256: "a".repeat(40) }),
      plannedCheck({ commandSha256: "not a hash" }),
      plannedCheck({ timeoutMs: 0 }),
      plannedCheck({ timeoutMs: -5 }),
      plannedCheck({ timeoutMs: SELECTED_CHECK_TIMEOUT_MS_MAX + 1 }),
      plannedCheck({ timeoutMs: 1.5 }),
      { scriptId: "lint" },
      "lint",
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });
});

describe("SelectedCheckTreeObservation", () => {
  const decode = Schema.decodeUnknownExit(SelectedCheckTreeObservation);

  it("decodes each documented kind", () => {
    for (const value of [
      completeTree(),
      completeTree(treeOid64),
      { kind: "unsupported", reason: "not-git" },
      { kind: "unsupported", reason: "sparse" },
      { kind: "unsupported", reason: "gitlink" },
      { kind: "unsupported", reason: "staging-failed" },
      { kind: "not-captured" },
    ]) {
      expect(Exit.isSuccess(decode(value))).toBe(true);
    }
  });

  it("rejects kinds, reasons, and oids outside the contract", () => {
    for (const value of [
      { kind: "complete", treeOid: "short" },
      { kind: "complete" },
      { kind: "unsupported", reason: "crashed" },
      { kind: "unsupported" },
      { kind: "missing" },
      {},
      "complete",
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });
});

describe("parseSelectedCheckInstant", () => {
  it("returns the instant for a real timestamp and null otherwise", () => {
    const instant = parseSelectedCheckInstant("2026-08-20T12:00:00.000Z");
    expect(instant).not.toBeNull();
    expect(DateTime.toEpochMillis(instant!)).toBe(
      DateTime.toEpochMillis(DateTime.makeUnsafe("2026-08-20T12:00:00Z")),
    );
    expect(parseSelectedCheckInstant("whenever")).toBeNull();
    expect(parseSelectedCheckInstant("2026-02-30T00:00:00Z")).toBeNull();
    expect(parseSelectedCheckInstant("2026-01-01T12:00:00")).toBeNull();
    expect(parseSelectedCheckInstant(null)).toBeNull();
    expect(parseSelectedCheckInstant(1_700_000_000)).toBeNull();
  });
});

describe("selectedCheckIntervalDisagreement", () => {
  it("is null when the end is at or after the start", () => {
    expect(
      selectedCheckIntervalDisagreement("2026-08-20T12:00:00Z", "2026-08-20T12:00:01Z"),
    ).toBeNull();
    expect(
      selectedCheckIntervalDisagreement("2026-08-20T12:00:00Z", "2026-08-20T12:00:00Z"),
    ).toBeNull();
  });

  it("compares instants, not spellings, across offsets", () => {
    expect(
      selectedCheckIntervalDisagreement("2026-08-20T14:00:00+02:00", "2026-08-20T12:00:00Z"),
    ).toBeNull();
    // Lexically later text can still be the earlier instant.
    expect(
      selectedCheckIntervalDisagreement("2026-08-20T12:30:00Z", "2026-08-20T13:00:00+02:00"),
    ).toBe("the end timestamp is before the start timestamp");
  });

  it("rejects invalid calendars instead of normalizing them away", () => {
    expect(selectedCheckIntervalDisagreement("2026-02-29T00:00:00Z", "2026-02-29T00:00:00Z")).toBe(
      "the start timestamp is not a real instant",
    );
    expect(selectedCheckIntervalDisagreement("2026-08-20T12:00:00Z", "2026-04-31T00:00:00Z")).toBe(
      "the end timestamp is not a real instant",
    );
  });

  it("names missing and invalid ends separately", () => {
    expect(selectedCheckIntervalDisagreement(null, "2026-08-20T12:00:00Z")).toBe(
      "the start timestamp is missing",
    );
    expect(selectedCheckIntervalDisagreement("whenever", "2026-08-20T12:00:00Z")).toBe(
      "the start timestamp is not a real instant",
    );
    expect(selectedCheckIntervalDisagreement("2026-08-20T12:00:00Z", null)).toBe(
      "the end timestamp is missing",
    );
    expect(selectedCheckIntervalDisagreement("2026-08-20T12:00:00Z", "later")).toBe(
      "the end timestamp is not a real instant",
    );
  });
});

describe("validateSelectedCheckPlan", () => {
  it("accepts a unique plan within the size bound", () => {
    expect(validateSelectedCheckPlan([plannedCheck(), plannedCheck({ scriptId: "test" })])).toEqual(
      [],
    );
    expect(
      validateSelectedCheckPlan(
        Array.from({ length: SELECTED_CHECK_MAX }, (_, index) =>
          plannedCheck({ scriptId: `check-${index}` }),
        ),
      ),
    ).toEqual([]);
  });

  it("rejects an empty or oversized plan", () => {
    expect(validateSelectedCheckPlan([])).toEqual(["the plan holds no checks"]);
    expect(
      validateSelectedCheckPlan(
        Array.from({ length: SELECTED_CHECK_MAX + 1 }, (_, index) =>
          plannedCheck({ scriptId: `check-${index}` }),
        ),
      ),
    ).toEqual([`the plan holds more than ${SELECTED_CHECK_MAX} checks`]);
  });

  it("names each scriptId planned more than once", () => {
    expect(
      validateSelectedCheckPlan([
        plannedCheck(),
        plannedCheck({ scriptId: "test" }),
        plannedCheck(),
      ]),
    ).toEqual(["script 'lint' is planned more than once"]);
  });
});

describe("selectedCheckTreeDisagreement", () => {
  it("is null only when both ends observed the same complete tree", () => {
    expect(selectedCheckTreeDisagreement(completeTree(), completeTree())).toBeNull();
    expect(selectedCheckTreeDisagreement(completeTree(treeOid64), completeTree())).toBe(
      "the workspace tree changed during the run",
    );
  });

  it("names which observation was not complete and why", () => {
    expect(
      selectedCheckTreeDisagreement({ kind: "unsupported", reason: "sparse" }, completeTree()),
    ).toBe("the starting tree was unsupported: sparse");
    expect(selectedCheckTreeDisagreement(completeTree(), { kind: "not-captured" })).toBe(
      "the ending tree was not captured",
    );
  });
});

const thread = ThreadId.make("thread-1");
const project = ProjectId.make("project-1");
const environment = EnvironmentId.make("env-1");
const attemptId = "attempt-1";
const attemptStartedAt = "2026-08-20T12:00:00Z";
const attemptEndedAt = "2026-08-20T12:01:00Z";

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

/**
 * A receipt of the exact shape a completed, fully proven attempt writes. It
 * is written by hand in this file: decoding it and passing it through the
 * derivation proves the schema and the derivation agree, and is never
 * evidence that a server executed anything.
 */
const passingReceipt = (): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId: thread,
  attemptId,
  revision: 2,
  threadAnchorSequence: 5,
  context: {
    projectId: project,
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    cwd: "/tmp/workspace",
    shell: "/bin/zsh",
    envSha256: sha256,
  },
  planned: [
    plannedCheck(),
    plannedCheck({ scriptId: "test", scriptName: "Test", commandSha256: "f".repeat(64) }),
  ],
  environment: {
    environmentId: environment,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "22.11.0",
  },
  tree: {
    atStart: completeTree(),
    atEnd: completeTree(),
    repoAtStart: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
    repoAtEnd: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
  },
  phase: "completed",
  checks: [
    passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"),
    passedResult("test", "2026-08-20T12:00:30Z", "2026-08-20T12:01:00Z"),
  ],
  startedAt: attemptStartedAt,
  endedAt: attemptEndedAt,
  error: null,
});

const presentRecord = (
  receipt: SelectedCheckReceipt = passingReceipt(),
  sequence: number = 7,
): SelectedChecksGetResult["record"] => ({ kind: "present", receipt, sequence });

describe("SelectedCheckResult", () => {
  const decode = Schema.decodeUnknownExit(SelectedCheckResult);

  it("accepts a passed check with full provenance", () => {
    expect(
      Exit.isSuccess(decode(passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z"))),
    ).toBe(true);
  });

  it("rejects statuses, exits, groups, and digests outside the contract", () => {
    const passed = passedResult("lint", "2026-08-20T12:00:00Z", "2026-08-20T12:00:30Z");
    for (const value of [
      { ...passed, status: "proved" },
      { ...passed, exitedBy: "os" },
      { ...passed, exitSignal: "S".repeat(33) },
      { ...passed, pgid: 0 },
      { ...passed, pgid: 2 ** 53 },
      { ...passed, pgid: 1.5 },
      { ...passed, group: "nonempty" },
      { ...passed, failure: "mystery" },
      { ...passed, stdout: { bytes: -1, sha256 } },
      { ...passed, stdout: { bytes: 2 ** 53, sha256 } },
      { ...passed, stdout: { bytes: 120, sha256: "a".repeat(63) } },
      { ...passed, scriptId: "   " },
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });
});

describe("SelectedCheckReceipt", () => {
  const decode = Schema.decodeUnknownExit(SelectedCheckReceipt);

  it("accepts the success fixture the derivation judges", () => {
    expect(Exit.isSuccess(decode(passingReceipt()))).toBe(true);
  });

  it("rejects wrong versions, oversized attempts, and unsafe counters", () => {
    for (const value of [
      { ...passingReceipt(), schemaVersion: 2 },
      { ...passingReceipt(), attemptId: "a".repeat(65) },
      { ...passingReceipt(), revision: -1 },
      { ...passingReceipt(), revision: 2 ** 53 },
      { ...passingReceipt(), threadAnchorSequence: -1 },
      { ...passingReceipt(), threadAnchorSequence: 2 ** 53 },
      { ...passingReceipt(), phase: "proved" },
      { ...passingReceipt(), error: "mystery" },
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });
});

describe("SelectedCheckAdmission", () => {
  const decode = Schema.decodeUnknownExit(SelectedCheckAdmission);

  it("decodes every admission state", () => {
    for (const value of [
      { state: "open" },
      { state: "reconciling" },
      { state: "busy", threadId: thread, attemptId },
      {
        state: "owner-unresolved",
        marker: {
          sha256: sha256,
          attemptId,
          threadId: thread,
          scriptId: "lint",
          pgid: 41234,
          writtenAt: attemptStartedAt,
        },
      },
      { state: "owner-corrupt", marker: { sha256: sha256, bytes: 128 } },
      { state: "owner-unreadable" },
      {
        state: "owner-unrecorded",
        owner: { attemptId, threadId: thread, scriptId: null, pgid: null },
      },
    ]) {
      expect(Exit.isSuccess(decode(value))).toBe(true);
    }
  });

  it("rejects unknown states and unsafe marker fields", () => {
    for (const value of [
      { state: "closed" },
      { state: "busy", threadId: thread },
      {
        state: "owner-unresolved",
        marker: {
          sha256: "z".repeat(64),
          attemptId,
          threadId: thread,
          scriptId: null,
          pgid: null,
          writtenAt: attemptStartedAt,
        },
      },
      { state: "owner-corrupt", marker: { sha256: sha256, bytes: -1 } },
      {
        state: "owner-unrecorded",
        owner: { attemptId, threadId: thread, scriptId: null, pgid: 0 },
      },
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });
});

describe("SelectedChecksGetResult", () => {
  const decode = Schema.decodeUnknownExit(SelectedChecksGetResult);
  const resultWith = (record: SelectedChecksGetResult["record"]) => ({
    capability: { available: true, reason: null },
    record,
    changedScriptIds: [],
    admission: { state: "open" },
  });

  it("decodes each record kind at the sequence bounds", () => {
    expect(Exit.isSuccess(decode(resultWith({ kind: "none" })))).toBe(true);
    expect(Exit.isSuccess(decode(resultWith({ kind: "malformed" })))).toBe(true);
    expect(Exit.isSuccess(decode(resultWith(presentRecord(passingReceipt(), 0))))).toBe(true);
    expect(Exit.isSuccess(decode(resultWith(presentRecord())))).toBe(true);
  });

  it("rejects unknown capability reasons, unsafe sequences, and unknown admissions", () => {
    expect(
      Exit.isFailure(
        decode({
          capability: { available: false, reason: "windows" },
          record: { kind: "none" },
          changedScriptIds: [],
          admission: { state: "open" },
        }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(decode(resultWith(presentRecord(passingReceipt(), 2 ** 53))))).toBe(true);
    expect(
      Exit.isFailure(
        decode({
          capability: { available: true, reason: null },
          record: { kind: "none" },
          changedScriptIds: [],
          admission: { state: "closed" },
        }),
      ),
    ).toBe(true);
  });
});

describe("SelectedChecksRunInput", () => {
  const decode = Schema.decodeUnknownExit(SelectedChecksRunInput);
  const scriptIds = (count: number) =>
    Array.from({ length: count }, (_, index) => `check-${index}`);

  it("accepts one up to SELECTED_CHECK_MAX unique script ids and trims them", () => {
    expect(Exit.isSuccess(decode({ threadId: thread, scriptIds: ["lint"] }))).toBe(true);
    expect(
      Exit.isSuccess(decode({ threadId: thread, scriptIds: scriptIds(SELECTED_CHECK_MAX) })),
    ).toBe(true);
    const decoded = Schema.decodeUnknownSync(SelectedChecksRunInput)({
      threadId: " thread-1 ",
      scriptIds: [" lint "],
    });
    expect(decoded).toEqual({ threadId: "thread-1", scriptIds: ["lint"] });
  });

  it("rejects none, too many, duplicates after trimming, and empty ids", () => {
    for (const value of [
      { threadId: thread, scriptIds: [] },
      { threadId: thread, scriptIds: scriptIds(SELECTED_CHECK_MAX + 1) },
      { threadId: thread, scriptIds: ["lint", "lint"] },
      { threadId: thread, scriptIds: ["lint", " lint"] },
      { threadId: thread, scriptIds: ["   "] },
      { threadId: "   ", scriptIds: ["lint"] },
    ]) {
      expect(Exit.isFailure(decode(value))).toBe(true);
    }
  });
});

describe("selected checks run, cancel, and resolve payloads", () => {
  it("round-trips the small shapes", () => {
    expect(Schema.decodeUnknownSync(SelectedChecksRunResult)({ attemptId })).toEqual({
      attemptId,
    });
    expect(
      Schema.decodeUnknownSync(SelectedChecksCancelInput)({ threadId: thread, attemptId }),
    ).toEqual({ threadId: "thread-1", attemptId });
    expect(Schema.decodeUnknownSync(SelectedChecksCancelResult)({ cancelled: true })).toEqual({
      cancelled: true,
    });
    expect(
      Schema.decodeUnknownSync(SelectedChecksResolveOwnershipInput)({
        markerSha256: null,
        acknowledgeUncertainty: true,
      }),
    ).toEqual({ markerSha256: null, acknowledgeUncertainty: true });
    expect(
      Schema.decodeUnknownSync(SelectedChecksResolveOwnershipResult)({
        outcome: "acknowledged",
        admission: { state: "open" },
      }).outcome,
    ).toBe("acknowledged");
  });

  it("rejects malformed attempts, markers, and outcomes", () => {
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(SelectedChecksCancelInput)({
          threadId: thread,
          attemptId: "a".repeat(65),
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(SelectedChecksResolveOwnershipInput)({
          markerSha256: "z".repeat(64),
          acknowledgeUncertainty: false,
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(SelectedChecksResolveOwnershipResult)({
          outcome: "wiped",
          admission: { state: "open" },
        }),
      ),
    ).toBe(true);
  });
});

describe("selected checks errors", () => {
  it("names its rejection reason and optional script", () => {
    expect(
      new SelectedChecksRejectedError({ reason: "script-not-found", scriptId: "lint" }).message,
    ).toBe("Selected checks rejected: script-not-found (lint)");
    expect(
      Exit.isSuccess(
        Schema.decodeUnknownExit(SelectedChecksRejectedError)({
          _tag: "SelectedChecksRejectedError",
          reason: "busy",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(SelectedChecksRejectedError)({
          _tag: "SelectedChecksRejectedError",
          reason: "mystery",
        }),
      ),
    ).toBe(true);
  });

  it("carries the missing thread id", () => {
    expect(new SelectedChecksThreadNotFoundError({ threadId: thread }).message).toBe(
      "Thread 'thread-1' does not exist.",
    );
    expect(
      Exit.isFailure(
        Schema.decodeUnknownExit(SelectedChecksThreadNotFoundError)({
          _tag: "SelectedChecksThreadNotFoundError",
          threadId: "",
        }),
      ),
    ).toBe(true);
  });
});

describe("selected checks and the client command union", () => {
  it("cannot be written through the client command union", () => {
    const decoded = Schema.decodeUnknownExit(ClientOrchestrationCommand)({
      type: "thread.activity.append",
      commandId: CommandId.make("command-1"),
      threadId: thread,
      activity: {
        id: EventId.make(selectedCheckReceiptId(thread)),
        tone: "info",
        kind: SELECTED_CHECK_RECEIPT_KIND,
        summary: "forged",
        payload: { forged: true },
        turnId: null,
        createdAt: attemptStartedAt,
      },
      createdAt: attemptStartedAt,
    });
    expect(Exit.isFailure(decoded)).toBe(true);
  });
});

describe("deriveSelectedCheckState", () => {
  const firstCheckMutated = (
    mutate: (check: SelectedCheckResult) => SelectedCheckResult,
  ): SelectedCheckReceipt => {
    const receipt = passingReceipt();
    return { ...receipt, checks: [mutate(receipt.checks[0]!), receipt.checks[1]!] };
  };

  const oneFieldMutations = (): Array<[string, SelectedCheckReceipt]> => {
    const receipt = passingReceipt();
    return [
      ["a cancelled phase", { ...receipt, phase: "cancelled" }],
      ["a recorded error", { ...receipt, error: "server-stopped" }],
      ["a reordered plan", { ...receipt, planned: [receipt.planned[1]!, receipt.planned[0]!] }],
      ["a shortened plan", { ...receipt, planned: receipt.planned.slice(0, 1) }],
      ["a reordered check list", { ...receipt, checks: [receipt.checks[1]!, receipt.checks[0]!] }],
      [
        "a check recorded as unproven",
        firstCheckMutated((check) => ({ ...check, status: "unproven" })),
      ],
      [
        "a nonzero exit on a passed check",
        firstCheckMutated((check) => ({ ...check, exitCode: 1 })),
      ],
      [
        "a check that exited on a signal",
        firstCheckMutated((check) => ({ ...check, exitedBy: "signal" })),
      ],
      [
        "a recorded exit signal",
        firstCheckMutated((check) => ({ ...check, exitSignal: "SIGTERM" })),
      ],
      ["a missing process group", firstCheckMutated((check) => ({ ...check, pgid: null }))],
      ["a zero process group", firstCheckMutated((check) => ({ ...check, pgid: 0 }))],
      ["an unsafe process group id", firstCheckMutated((check) => ({ ...check, pgid: 2 ** 53 }))],
      [
        "a non-empty process group",
        firstCheckMutated((check) => ({ ...check, group: "terminated" })),
      ],
      [
        "a missing standard-output digest",
        firstCheckMutated((check) => ({ ...check, stdout: null })),
      ],
      [
        "a missing standard-error digest",
        firstCheckMutated((check) => ({ ...check, stderr: null })),
      ],
      [
        "a recorded failure",
        firstCheckMutated((check) => ({ ...check, failure: "cleanup-timeout" })),
      ],
      [
        "an impossible check timestamp",
        firstCheckMutated((check) => ({ ...check, startedAt: "2026-02-30T00:00:00Z" })),
      ],
      [
        "a check that ended before it started",
        firstCheckMutated((check) => ({ ...check, endedAt: "2026-08-20T11:59:30Z" })),
      ],
      [
        "overlapping check windows",
        {
          ...receipt,
          checks: [
            receipt.checks[0]!,
            { ...receipt.checks[1]!, startedAt: "2026-08-20T12:00:15Z" },
          ],
        },
      ],
      [
        "a check outside the attempt window",
        firstCheckMutated((check) => ({ ...check, startedAt: "2026-08-20T11:59:00Z" })),
      ],
      ["an attempt that ended before it started", { ...receipt, endedAt: "2026-08-20T11:59:00Z" }],
      ["a missing attempt end", { ...receipt, endedAt: null }],
      [
        "trees that disagree",
        {
          ...receipt,
          tree: { ...receipt.tree, atEnd: { kind: "complete", treeOid: "9".repeat(40) } },
        },
      ],
      [
        "an uncaptured ending tree",
        { ...receipt, tree: { ...receipt.tree, atEnd: { kind: "not-captured" } } },
      ],
      [
        "ends in another clone of the same tree",
        {
          ...receipt,
          tree: {
            ...receipt.tree,
            repoAtEnd: { topLevel: "/tmp/workspace", commonDir: "/elsewhere/.git" },
          },
        },
      ],
      [
        "a missing repository identity",
        { ...receipt, tree: { ...receipt.tree, repoAtStart: null } },
      ],
      ["a missing event anchor", { ...receipt, threadAnchorSequence: null }],
      ["an anchor newer than the record", { ...receipt, threadAnchorSequence: 8 }],
    ];
  };

  it("judges the hand-written success fixture all-selected-passed without claiming any server ran it", () => {
    expect(Exit.isSuccess(Schema.decodeUnknownExit(SelectedCheckReceipt)(passingReceipt()))).toBe(
      true,
    );
    expect(deriveSelectedCheckState(presentRecord())).toEqual({
      state: "all-selected-passed",
      reasons: [],
    });
  });

  it("judges a missing or malformed record without touching a receipt", () => {
    expect(deriveSelectedCheckState({ kind: "none" })).toEqual({ state: "none", reasons: [] });
    expect(deriveSelectedCheckState({ kind: "malformed" })).toEqual({
      state: "incomplete",
      reasons: ["the stored record is malformed"],
    });
  });

  it("reads a running attempt as running ahead of every other verdict", () => {
    const running: SelectedCheckReceipt = { ...passingReceipt(), phase: "running" };
    expect(deriveSelectedCheckState(presentRecord(running))).toEqual({
      state: "running",
      reasons: [],
    });
  });

  it("reads an observed nonzero exit as failed ahead of every pass condition", () => {
    const receipt = passingReceipt();
    const failed: SelectedCheckReceipt = {
      ...receipt,
      checks: [
        receipt.checks[0]!,
        { ...receipt.checks[1]!, status: "failed", exitCode: 2, group: "killed" },
      ],
    };
    expect(deriveSelectedCheckState(presentRecord(failed))).toEqual({
      state: "failed",
      reasons: ["'test' exited 2"],
    });
  });

  it("reads failed only on positive evidence: a failed status without an exit code stays incomplete", () => {
    const receipt = passingReceipt();
    const unevidenced: SelectedCheckReceipt = {
      ...receipt,
      checks: [{ ...receipt.checks[0]!, status: "failed", exitCode: null }],
    };
    const derived = deriveSelectedCheckState(presentRecord(unevidenced));
    expect(derived.state).toBe("incomplete");
    expect(derived.reasons).toContain("'lint' was recorded as failed");
  });

  it("refuses all-selected-passed when one field breaks one proof", () => {
    for (const [label, mutated] of oneFieldMutations()) {
      const derived = deriveSelectedCheckState(presentRecord(mutated));
      expect(derived.state, label).toBe("incomplete");
      expect(derived.reasons.length, label).toBeGreaterThan(0);
    }
  });
});
