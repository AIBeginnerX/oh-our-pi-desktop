import {
  ProjectId,
  TaskResultRejectedError,
  TaskResultThreadNotFoundError,
  ThreadId,
  WS_METHODS,
  type SelectedCheckReceipt,
  type TaskResultGetResult,
  type TaskResultRecord,
  type TaskResultRequirementItem,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { act, createElement, StrictMode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { SelectedChecksCurrentSource } from "./selectedChecks";
import {
  callsOf,
  completion,
  drainTaskResultBag,
  entriesOf,
  getTaskResultBag,
  type TaskResultTestBag,
} from "./taskResult.test-fixture";
import {
  deriveTaskResultControls,
  noticeForMutationFailure,
  sameTaskResultAuthority,
  taskResultAccept,
  taskResultAuthorityFromSource,
  taskResultFetchTrigger,
  taskResultGet,
  taskResultSetRequirements,
  taskResultWithdraw,
  useTaskResult,
} from "./taskResult";

const GET_METHOD = WS_METHODS.taskResultGet;
const SET_METHOD = WS_METHODS.taskResultSetRequirements;
const ACCEPT_METHOD = WS_METHODS.taskResultAccept;
const WITHDRAW_METHOD = WS_METHODS.taskResultWithdraw;

const GET_LABEL = taskResultGet.label;
const SET_LABEL = taskResultSetRequirements.label;
const ACCEPT_LABEL = taskResultAccept.label;
const WITHDRAW_LABEL = taskResultWithdraw.label;

vi.mock("../connection/runtime", async () => ({
  connectionAtomRuntime: (await import("./taskResult.test-fixture")).getTaskResultBag().testRuntime,
}));

vi.mock("./use-atom-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-atom-command")>();
  const { getTaskResultBag: bag, wrapUseAtomCommand: wrap } =
    await import("./taskResult.test-fixture");
  return wrap(original, bag());
});

vi.mock("./entities", () => ({
  useThreadShell: () => ({ latestTurn: { state: "completed" } }),
}));

const sourceBag = {
  confirmationAttempt: 1,
  permission: "allowed" as "allowed" | "read-only" | "unknown",
};

function minimalRecord(overrides: Partial<TaskResultRecord> = {}): TaskResultRecord {
  return {
    schemaVersion: 1,
    threadId,
    revision: 0,
    threadIncarnation: 2,
    requirements: {
      version: 1,
      items: [{ id: "r1", text: "Lint", scriptIds: ["lint"] }],
      checks: [{ scriptId: "lint", commandSha256: "a".repeat(64) }],
      setAt: "2026-01-01T00:00:00.000Z",
    },
    acceptance: null,
    ...overrides,
  };
}

function minimalGetResult(overrides: Partial<TaskResultGetResult> = {}): TaskResultGetResult {
  return {
    record: { kind: "present", record: minimalRecord(), sequence: 1 },
    threadIncarnation: 2,
    checks: {
      capability: { available: true, reason: null },
      record: { kind: "none" },
      changedScriptIds: [],
      admission: { state: "open" },
      treeUnchanged: true,
      environmentMatches: true,
      contextMatches: true,
    },
    ...overrides,
  };
}

/**
 * A completed, bound check attempt that satisfies every `deriveTaskResultState`
 * provenance gate for `minimalRecord()`: same thread, anchor inside the current
 * incarnation, one-for-one plan alignment with the pinned command hash,
 * proven pass, equal tree/repo at both ends, current observations all true.
 */
function eligibleReceipt(): SelectedCheckReceipt {
  return {
    schemaVersion: 1,
    threadId,
    attemptId: "attempt-1",
    revision: 1,
    threadAnchorSequence: 2,
    context: {
      projectId: ProjectId.make("project-task-result"),
      workspaceRoot: "/repo",
      worktreePath: "/repo",
      cwd: "/repo",
      shell: "/bin/sh",
      envSha256: "b".repeat(64),
    },
    planned: [
      {
        scriptId: "lint",
        scriptName: "Lint",
        commandSha256: "a".repeat(64),
        timeoutMs: 60_000,
      },
    ],
    environment: {
      environmentId,
      platform: "linux",
      arch: "x64",
      osRelease: "1.0",
      serverVersion: "0.0.0",
      nodeVersion: "24.0.0",
    },
    tree: {
      atStart: { kind: "complete", treeOid: "c".repeat(40) },
      atEnd: { kind: "complete", treeOid: "c".repeat(40) },
      repoAtStart: { topLevel: "/repo", commonDir: "/repo/.git" },
      repoAtEnd: { topLevel: "/repo", commonDir: "/repo/.git" },
    },
    phase: "completed",
    checks: [
      {
        scriptId: "lint",
        status: "passed",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        exitCode: 0,
        exitedBy: "exit",
        exitSignal: null,
        pgid: 42,
        group: "empty",
        stdout: { bytes: 0, sha256: "e".repeat(64) },
        stderr: { bytes: 0, sha256: "e".repeat(64) },
        failure: null,
      },
    ],
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: "2026-01-01T00:01:00.000Z",
    error: null,
  };
}

/** A read whose derived state is `awaiting-acceptance`: `controls.accept` is enabled. */
function eligibleGetResult(overrides: Partial<TaskResultGetResult> = {}): TaskResultGetResult {
  return {
    record: { kind: "present", record: minimalRecord(), sequence: 1 },
    threadIncarnation: 2,
    checks: {
      capability: { available: true, reason: null },
      record: { kind: "present", receipt: eligibleReceipt(), sequence: 7 },
      changedScriptIds: [],
      admission: { state: "open" },
      treeUnchanged: true,
      environmentMatches: true,
      contextMatches: true,
    },
    ...overrides,
  };
}

function source(overrides: Partial<SelectedChecksCurrentSource> = {}): SelectedChecksCurrentSource {
  return {
    environmentId,
    threadId,
    lifecycleKey: "lifecycle-a",
    permission: sourceBag.permission,
    permissionStatus: "confirmed",
    confirmationAttempt: sourceBag.confirmationAttempt,
    recordKey: "run:1:7:completed",
    projectId: ProjectId.make("project-task-result"),
    view: {
      open: true,
      headline: "passed",
      hasCurrentAuthority: true,
      getInFlight: false,
      getError: null,
      record: null,
      recordAuthority: "current",
      derived: null,
      live: null,
      liveIsNewer: false,
      admission: { state: "open" },
      capability: { available: true, reason: null },
      changedScriptIds: [],
      comparisonStale: false,
      newerTurnAfterRecord: false,
      selection: [],
      pendingRunAttemptId: null,
      commandInFlight: null,
      notice: null,
      stopAttemptId: null,
      canRun: false,
      canStop: false,
      canRecover: false,
      dialog: null,
      dialogSubmit: null,
    },
    ...overrides,
  };
}

function stableReadSource(): SelectedChecksCurrentSource {
  return source();
}

async function settleGet(methodOrdinal: number, value: TaskResultGetResult = minimalGetResult()) {
  const entry = entriesOf(bag, GET_METHOD)[methodOrdinal - 1];
  if (entry === undefined) throw new Error("no pending get");
  await act(async () => {
    entry.deferred.resolve(value);
    await completion(bag, GET_LABEL, methodOrdinal);
  });
}

const bag: TaskResultTestBag = getTaskResultBag();
const environmentId = bag.environmentId;
const threadId = bag.threadId;
let renderer: ReactTestRenderer | undefined;

const hookRef: { current: ReturnType<typeof useTaskResult> | null } = { current: null };

function HarnessStable() {
  hookRef.current = useTaskResult({
    environmentId,
    threadId,
    readCurrentSource: stableReadSource,
    recordKey: "run:1:7:completed",
  });
  return null;
}

function stableTree() {
  return createElement(
    RegistryContext.Provider,
    { value: bag.registry },
    createElement(HarnessStable),
  );
}

function stableTreeStrict() {
  return createElement(
    StrictMode,
    {},
    createElement(RegistryContext.Provider, { value: bag.registry }, createElement(HarnessStable)),
  );
}

describe("deriveTaskResultControls", () => {
  it("disables accept for read-only permission", () => {
    const result = minimalGetResult();
    const controls = deriveTaskResultControls(result, threadId, "read-only", false);
    expect(controls.canEdit).toBe(false);
    expect(controls.accept).toBeNull();
  });

  it("rejects a record written for another thread", () => {
    const other = ThreadId.make("thread-other");
    const result = minimalGetResult({
      record: {
        kind: "present",
        record: minimalRecord({ threadId: other }),
        sequence: 1,
      },
    });
    expect(deriveTaskResultControls(result, threadId, "allowed", false).base).toBeNull();
  });
});

describe("taskResultAuthority", () => {
  it("includes confirmation attempt in fetch trigger", () => {
    const a = taskResultFetchTrigger(
      taskResultAuthorityFromSource(source({ confirmationAttempt: 1 })),
      "k",
    );
    const b = taskResultFetchTrigger(
      taskResultAuthorityFromSource(source({ confirmationAttempt: 2 })),
      "k",
    );
    expect(a).not.toBe(b);
    expect(
      sameTaskResultAuthority(
        taskResultAuthorityFromSource(source({ confirmationAttempt: 1 })),
        taskResultAuthorityFromSource(source({ confirmationAttempt: 2 })),
      ),
    ).toBe(false);
  });
});

describe("noticeForMutationFailure", () => {
  it("maps write-unconfirmed conflict to fixed copy", () => {
    const notice = noticeForMutationFailure(
      new TaskResultRejectedError({ reason: "conflict", detail: "write-unconfirmed" }),
    );
    expect(notice.message).toBe("The write could not be confirmed. Refresh before trying again.");
  });
});

describe("useTaskResult", () => {
  beforeEach(() => {
    bag.rpcEntries.length = 0;
    bag.rpcCalls.length = 0;
    bag.recorded.completions.length = 0;
    bag.teardown.current = false;
    bag.setFailure.current = new TaskResultRejectedError({
      reason: "conflict",
      detail: "write-unconfirmed",
    });
    bag.getFailure.current = null;
    sourceBag.confirmationAttempt = 1;
    sourceBag.permission = "allowed";
    hookRef.current = null;
    renderer = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    if (renderer !== undefined) {
      await act(() => renderer?.unmount());
      renderer = undefined;
    }
    await act(async () => {
      await drainTaskResultBag(bag);
    });
    vi.unstubAllGlobals();
  });

  it("blocks a second write while reconciliation get is held and preserves draft text", async () => {
    const editedItems: ReadonlyArray<TaskResultRequirementItem> = [
      { id: "r1", text: "Edited lint requirement", scriptIds: ["lint"] },
    ];
    await act(() => {
      renderer = create(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 1);
    });
    await settleGet(1);
    expect(callsOf(bag, GET_METHOD)).toEqual([{ threadId }]);

    await act(async () => {
      hookRef.current?.setDraftItems(editedItems);
    });
    await act(async () => {
      hookRef.current?.setRequirements(editedItems);
      await bag.waitForCall(SET_METHOD, 1);
      await completion(bag, SET_LABEL, 1);
      await bag.waitForCall(GET_METHOD, 2);
    });
    expect(callsOf(bag, SET_METHOD)).toEqual([
      {
        threadId,
        threadIncarnation: 2,
        expectedRevision: 0,
        items: editedItems,
      },
    ]);
    expect(entriesOf(bag, GET_METHOD)).toHaveLength(2);
    expect(hookRef.current?.draftUnsaved).toBe(true);
    expect(hookRef.current?.draftItems[0]?.text).toBe("Edited lint requirement");

    await act(async () => {
      hookRef.current?.setRequirements(editedItems);
    });
    expect(callsOf(bag, SET_METHOD)).toHaveLength(1);

    await settleGet(2);
    expect(hookRef.current?.draftItems[0]?.text).toBe("Edited lint requirement");
    expect(hookRef.current?.draftUnsaved).toBe(true);
  });

  it("re-issues a read when confirmation attempt changes with a stable readCurrentSource", async () => {
    await act(() => {
      renderer = create(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 1);
    });
    await settleGet(1);
    expect(entriesOf(bag, GET_METHOD)).toHaveLength(1);

    sourceBag.confirmationAttempt = 2;
    await act(() => {
      renderer?.update(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 2);
    });
    await settleGet(2);
    expect(entriesOf(bag, GET_METHOD)).toHaveLength(2);
  });

  it("preserves edited draft after a successful withdraw", async () => {
    const acceptedResult = minimalGetResult({
      record: {
        kind: "present",
        record: minimalRecord({
          acceptance: {
            requirementsVersion: 1,
            checkAttemptId: "attempt-1",
            checkReceiptSequence: 7,
            acceptedAt: "2026-01-01T00:00:00.000Z",
          },
        }),
        sequence: 1,
      },
    });
    await act(() => {
      renderer = create(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 1);
    });
    await settleGet(1, acceptedResult);
    await act(async () => {
      hookRef.current?.setDraftItems([
        { id: "r1", text: "Still editing after accept", scriptIds: ["lint"] },
      ]);
    });
    await act(async () => {
      hookRef.current?.withdraw();
      await bag.waitForCall(WITHDRAW_METHOD, 1);
    });
    const withdrawEntry = entriesOf(bag, WITHDRAW_METHOD)[0];
    if (withdrawEntry === undefined) throw new Error("no pending withdraw");
    await act(async () => {
      withdrawEntry.deferred.resolve(
        minimalGetResult({
          record: {
            kind: "present",
            record: minimalRecord({ acceptance: null }),
            sequence: 1,
          },
        }),
      );
      await completion(bag, WITHDRAW_LABEL, 1);
    });
    expect(callsOf(bag, WITHDRAW_METHOD)).toEqual([
      { threadId, threadIncarnation: 2, expectedRevision: 0 },
    ]);
    expect(hookRef.current?.draftItems[0]?.text).toBe("Still editing after accept");
    expect(hookRef.current?.draftUnsaved).toBe(true);
  });

  it("runs the real accept endpoint with the exact tuple only under an allowed eligible read", async () => {
    const eligible = eligibleGetResult();
    await act(() => {
      renderer = create(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 1);
    });
    await settleGet(1, eligible);
    const ready = hookRef.current?.state;
    if (ready?.phase !== "ready") throw new Error("expected ready");
    expect(ready.derived.state).toBe("awaiting-acceptance");
    expect(ready.controls.accept).not.toBeNull();

    sourceBag.permission = "read-only";
    await act(() => {
      renderer?.update(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 2);
    });
    await settleGet(2, eligible);
    const readOnly = hookRef.current?.state;
    if (readOnly?.phase !== "ready") throw new Error("expected ready");
    expect(readOnly.controls.accept).toBeNull();
    await act(async () => {
      hookRef.current?.accept();
    });
    expect(callsOf(bag, ACCEPT_METHOD)).toEqual([]);

    sourceBag.permission = "allowed";
    sourceBag.confirmationAttempt = 2;
    await act(() => {
      renderer?.update(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 3);
    });
    await settleGet(3, eligible);
    await act(async () => {
      hookRef.current?.accept();
      await bag.waitForCall(ACCEPT_METHOD, 1);
    });
    expect(callsOf(bag, ACCEPT_METHOD)).toEqual([
      {
        threadId,
        threadIncarnation: 2,
        expectedRevision: 0,
        requirementsVersion: 1,
        checkAttemptId: "attempt-1",
        checkReceiptSequence: 7,
      },
    ]);
    const acceptEntry = entriesOf(bag, ACCEPT_METHOD)[0];
    if (acceptEntry === undefined) throw new Error("no pending accept");
    const acceptedResult = eligibleGetResult({
      record: {
        kind: "present",
        record: minimalRecord({
          acceptance: {
            requirementsVersion: 1,
            checkAttemptId: "attempt-1",
            checkReceiptSequence: 7,
            acceptedAt: "2026-01-01T00:00:02.000Z",
          },
        }),
        sequence: 1,
      },
    });
    await act(async () => {
      acceptEntry.deferred.resolve(acceptedResult);
      await completion(bag, ACCEPT_LABEL, 1);
    });
    const accepted = hookRef.current?.state;
    if (accepted?.phase !== "ready") throw new Error("expected ready");
    expect(accepted.derived.state).toBe("verified");
  });

  it("drops a superseded held get after authority change under StrictMode replay", async () => {
    const staleEligible = eligibleGetResult();
    const current = minimalGetResult();
    await act(() => {
      renderer = create(stableTreeStrict());
    });
    // StrictMode replays the read effect: mount issues get A, the cleanup
    // invalidates it, and re-setup issues the same read again as A'.
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 2);
    });
    sourceBag.confirmationAttempt = 2;
    await act(() => {
      renderer?.update(stableTreeStrict());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 3);
    });
    // The newer read settles first; both superseded reads settle after and
    // must not publish their accept-eligible data.
    await settleGet(3, current);
    await settleGet(1, staleEligible);
    await settleGet(2, staleEligible);
    const st = hookRef.current?.state;
    if (st?.phase !== "ready") throw new Error("expected ready");
    expect(st.result).toBe(current);
    expect(st.derived.state).toBe("needs-confirmation");
    expect(st.controls.accept).toBeNull();
    await act(async () => {
      hookRef.current?.accept();
    });
    expect(callsOf(bag, ACCEPT_METHOD)).toEqual([]);
  });

  it("recovers through the real get endpoint on explicit refresh after a failed read", async () => {
    bag.getFailure.current = new TaskResultThreadNotFoundError({ threadId });
    await act(() => {
      renderer = create(stableTree());
    });
    await act(async () => {
      await bag.waitForCall(GET_METHOD, 1);
      await completion(bag, GET_LABEL, 1);
    });
    expect(hookRef.current?.state.phase).toBe("read-failed");

    bag.getFailure.current = null;
    const recovered = minimalGetResult();
    await act(async () => {
      hookRef.current?.refresh();
      await bag.waitForCall(GET_METHOD, 2);
    });
    await settleGet(2, recovered);
    const st = hookRef.current?.state;
    if (st?.phase !== "ready") throw new Error("expected ready");
    expect(st.result).toBe(recovered);
    expect(callsOf(bag, GET_METHOD)).toEqual([{ threadId }, { threadId }]);
  });
});
