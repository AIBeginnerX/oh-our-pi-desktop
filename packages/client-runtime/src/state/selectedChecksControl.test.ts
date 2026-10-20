import {
  EnvironmentId,
  ProjectId,
  SELECTED_CHECK_MAX,
  SelectedChecksGetResult,
  ThreadId,
  deriveSelectedCheckState,
  type SelectedCheckReceipt,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveSelectedChecksView,
  initialSelectedChecksControl,
  reduceSelectedChecksControl,
  type SelectedChecksControlEffect,
  type SelectedChecksControlEvent,
  type SelectedChecksControlState,
  type SelectedChecksTarget,
} from "./selectedChecksControl.ts";

const environmentId = EnvironmentId.make("env-1");
const threadA = ThreadId.make("thread-a");
const threadB = ThreadId.make("thread-b");
const projectId = ProjectId.make("project-1");
const sha256 = "a".repeat(64);

const target = (threadId: ThreadId): SelectedChecksTarget => ({
  environmentId,
  threadId,
});
const targetA = target(threadA);
const targetB = target(threadB);

const lifecycle = (
  key: string,
  canRead: boolean,
  threadTarget: SelectedChecksTarget = targetA,
): SelectedChecksControlEvent => ({
  type: "lifecycle",
  key,
  canRead,
  target: threadTarget,
});

const openPanel = (
  seedIds: ReadonlyArray<string> = [],
  canRead = true,
  threadTarget: SelectedChecksTarget = targetA,
): SelectedChecksControlEvent => ({
  type: "open",
  seedIds,
  canRead,
  target: threadTarget,
});

const decodeGetResult = (partial: {
  record: SelectedChecksGetResult["record"];
  changedScriptIds?: ReadonlyArray<string>;
  admission?: SelectedChecksGetResult["admission"];
  capability?: SelectedChecksGetResult["capability"];
}): SelectedChecksGetResult =>
  Schema.decodeUnknownSync(SelectedChecksGetResult)({
    capability: partial.capability ?? { available: true, reason: null },
    record: partial.record,
    changedScriptIds: partial.changedScriptIds ?? [],
    admission: partial.admission ?? { state: "open" },
  });

const passingReceipt = (overrides: Partial<SelectedCheckReceipt> = {}): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId: threadA,
  attemptId: "attempt-a",
  revision: 2,
  threadAnchorSequence: 5,
  context: {
    projectId,
    workspaceRoot: "/tmp/workspace",
    worktreePath: null,
    cwd: "/tmp/workspace",
    shell: "/bin/zsh",
    envSha256: sha256,
  },
  planned: [
    {
      scriptId: "lint",
      scriptName: "Lint",
      commandSha256: sha256,
      timeoutMs: 60_000,
    },
    {
      scriptId: "test",
      scriptName: "Test",
      commandSha256: "f".repeat(64),
      timeoutMs: 60_000,
    },
  ],
  environment: {
    environmentId,
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.6.0",
    serverVersion: "1.0.0",
    nodeVersion: "22.11.0",
  },
  tree: {
    atStart: { kind: "complete", treeOid: "b".repeat(40) },
    atEnd: { kind: "complete", treeOid: "b".repeat(40) },
    repoAtStart: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
    repoAtEnd: { topLevel: "/tmp/workspace", commonDir: "/tmp/workspace" },
  },
  phase: "completed",
  checks: [
    {
      scriptId: "lint",
      status: "passed",
      startedAt: "2026-08-20T12:00:00Z",
      endedAt: "2026-08-20T12:00:30Z",
      exitCode: 0,
      exitedBy: "exit",
      exitSignal: null,
      pgid: 41234,
      group: "empty",
      stdout: { bytes: 120, sha256 },
      stderr: { bytes: 0, sha256: "e".repeat(64) },
      failure: null,
    },
    {
      scriptId: "test",
      status: "passed",
      startedAt: "2026-08-20T12:00:30Z",
      endedAt: "2026-08-20T12:01:00Z",
      exitCode: 0,
      exitedBy: "exit",
      exitSignal: null,
      pgid: 41234,
      group: "empty",
      stdout: { bytes: 120, sha256 },
      stderr: { bytes: 0, sha256: "e".repeat(64) },
      failure: null,
    },
  ],
  startedAt: "2026-08-20T12:00:00Z",
  endedAt: "2026-08-20T12:01:00Z",
  error: null,
  ...overrides,
});

const presentRecord = (
  receipt: SelectedCheckReceipt,
  sequence = 7,
): SelectedChecksGetResult["record"] => ({
  kind: "present",
  receipt,
  sequence,
});

const okOutcome = (result: SelectedChecksGetResult) => ({
  kind: "ok" as const,
  result,
});

const reduceChain = (
  initial: SelectedChecksControlState,
  events: ReadonlyArray<SelectedChecksControlEvent>,
): { state: SelectedChecksControlState; effects: ReadonlyArray<SelectedChecksControlEffect> } => {
  let state = initial;
  const effects: SelectedChecksControlEffect[] = [];
  for (const event of events) {
    const next = reduceSelectedChecksControl(state, event);
    state = next.state;
    if (next.effect !== null) effects.push(next.effect);
  }
  return { state, effects };
};

const viewInput = (
  control: SelectedChecksControlState,
  overrides: Partial<Parameters<typeof deriveSelectedChecksView>[0]> = {},
) => ({
  control,
  live: null,
  permission: "allowed" as const,
  connected: true,
  candidateIds: ["lint", "test"],
  latestTurnRequestedAt: null,
  ...overrides,
});

describe("reduceSelectedChecksControl", () => {
  it("ignores stale get completions in arrival order", () => {
    const key = '{"conn":1}';
    let state = initialSelectedChecksControl();
    ({ state } = reduceSelectedChecksControl(state, lifecycle(key, true)));
    ({ state } = reduceSelectedChecksControl(state, openPanel([], true)));
    const opened = reduceSelectedChecksControl(state, { type: "manual-refresh" });
    expect(opened.effect?.type).toBe("get");
    const staleGen = opened.state.gen;
    const refreshed = reduceSelectedChecksControl(opened.state, { type: "manual-refresh" });
    expect(refreshed.state.gen).toBeGreaterThan(staleGen);
    const stale = reduceSelectedChecksControl(refreshed.state, {
      type: "get-settled",
      gen: staleGen,
      outcome: okOutcome(
        decodeGetResult({ record: presentRecord(passingReceipt({ attemptId: "stale" })) }),
      ),
    });
    expect(stale.state).toBe(refreshed.state);
    const current = reduceSelectedChecksControl(refreshed.state, {
      type: "get-settled",
      gen: refreshed.state.gen,
      outcome: okOutcome(
        decodeGetResult({ record: presentRecord(passingReceipt({ attemptId: "fresh" })) }),
      ),
    });
    expect(current.state.get.outcome?.kind).toBe("ok");
    if (current.state.get.outcome?.kind === "ok") {
      expect(current.state.get.outcome.result.record).toMatchObject({
        kind: "present",
        receipt: { attemptId: "fresh" },
      });
    }
  });

  it("emits one get when the same lifecycle key becomes readable while open", () => {
    const key = '{"conn":1}';
    const { state: opened } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
    ]);
    const unreadable = reduceSelectedChecksControl(opened, lifecycle(key, false));
    expect(unreadable.effect).toBeNull();
    const readable = reduceSelectedChecksControl(unreadable.state, lifecycle(key, true));
    expect(readable.effect).toMatchObject({ type: "get", lifecycle: key, target: targetA });
    expect(readable.state.get.phase).toBe("loading");
  });

  it("drops read authority on disconnect without a get and issues exactly one get when readable again", () => {
    const keyDisconnected = '{"conn":1}';
    const keyReconnected = '{"conn":2}';
    const { state: afterOpen, effects: setupEffects } = reduceChain(
      initialSelectedChecksControl(),
      [
        lifecycle(keyDisconnected, true),
        { type: "candidates-changed", ids: ["lint"] },
        openPanel([], true),
      ],
    );
    expect(setupEffects).toEqual([
      expect.objectContaining({ type: "get", lifecycle: keyDisconnected, target: targetA }),
    ]);
    const accepted = reduceSelectedChecksControl(afterOpen, {
      type: "get-settled",
      gen: afterOpen.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    expect(deriveSelectedChecksView(viewInput(accepted.state)).hasCurrentAuthority).toBe(true);

    const disconnected = reduceSelectedChecksControl(
      accepted.state,
      lifecycle(keyDisconnected, false),
    );
    expect(disconnected.effect).toBeNull();
    expect(disconnected.state.get.phase).toBe("idle");
    expect(disconnected.state.canRead).toBe(false);
    expect(deriveSelectedChecksView(viewInput(disconnected.state)).hasCurrentAuthority).toBe(false);

    for (const event of [
      { type: "manual-refresh" as const },
      { type: "focus-refresh" as const },
      { type: "candidates-changed" as const, ids: ["lint", "test"] },
      { type: "live-terminal" as const, key: "stale:1" },
    ]) {
      const blocked = reduceSelectedChecksControl(disconnected.state, event);
      expect(blocked.effect).toBeNull();
      expect(blocked.state.get.phase).toBe("idle");
      expect(deriveSelectedChecksView(viewInput(blocked.state)).getInFlight).toBe(false);
    }

    const reconnected = reduceSelectedChecksControl(
      disconnected.state,
      lifecycle(keyReconnected, true),
    );
    expect(reconnected.effect).toMatchObject({
      type: "get",
      gen: reconnected.state.gen,
      lifecycle: keyReconnected,
      target: targetA,
    });
    expect(reconnected.state.get.phase).toBe("loading");
    const onlyThat = reduceSelectedChecksControl(reconnected.state, {
      type: "get-settled",
      gen: reconnected.state.gen,
      outcome: okOutcome(decodeGetResult({ record: { kind: "none" } })),
    });
    expect(onlyThat.state.get.phase).toBe("settled");
  });

  it("never starts a get on close and only prunes candidates while closed", () => {
    const key = '{"conn":1}';
    const { state: openState } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint", "test"] },
      { type: "toggle", id: "lint" },
      { type: "toggle", id: "test" },
    ]);
    const closed = reduceSelectedChecksControl(openState, { type: "close" });
    expect(closed.effect).toBeNull();
    expect(closed.state.open).toBe(false);
    const pruned = reduceSelectedChecksControl(closed.state, {
      type: "candidates-changed",
      ids: ["lint"],
    });
    expect(pruned.effect).toBeNull();
    expect(pruned.state.selection.ids).toEqual(["lint"]);
  });

  it("clears retained record and selection when the target changes", () => {
    const key = '{"conn":1}';
    const receiptA = passingReceipt({ attemptId: "attempt-a", threadId: threadA });
    const { state: onA } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true, targetA),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel(["lint"], true, targetA),
    ]);
    const settledA = reduceSelectedChecksControl(onA, {
      type: "get-settled",
      gen: onA.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(receiptA) })),
    });
    expect(settledA.state.lastResult).not.toBeNull();
    expect(settledA.state.selection.ids).toEqual(["lint"]);
    const staleGen = settledA.state.gen;

    const switched = reduceSelectedChecksControl(settledA.state, lifecycle(key, true, targetB));
    expect(switched.state.lastResult).toBeNull();
    expect(switched.state.selection).toEqual({
      seededFor: null,
      userEdited: false,
      ids: [],
    });
    expect(switched.state.lastCandidates).toEqual([]);
    expect(switched.effect?.target).toEqual(targetB);
    const afterSwitchView = deriveSelectedChecksView(viewInput(switched.state));
    expect(afterSwitchView.record).toBeNull();
    expect(afterSwitchView.recordAuthority).toBeNull();

    const withCandidates = reduceSelectedChecksControl(switched.state, {
      type: "candidates-changed",
      ids: ["lint"],
    });
    expect(withCandidates.state.lastCandidates).toEqual(["lint"]);
    const settledB = reduceSelectedChecksControl(withCandidates.state, {
      type: "get-settled",
      gen: withCandidates.state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt({ attemptId: "attempt-b", threadId: threadB })),
        }),
      ),
    });
    expect(settledB.state.lastResult?.record).toMatchObject({
      kind: "present",
      receipt: { attemptId: "attempt-b", threadId: threadB },
    });
    expect(settledB.state.selection.ids).toEqual(["lint"]);

    const staleA = reduceSelectedChecksControl(settledB.state, {
      type: "get-settled",
      gen: staleGen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(receiptA) })),
    });
    expect(staleA.state).toBe(settledB.state);
    expect(staleA.effect).toBeNull();
    expect(deriveSelectedChecksView(viewInput(staleA.state)).record).toMatchObject({
      receipt: { attemptId: "attempt-b" },
    });
  });

  it("captures command target and clones run script ids immutably", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint"] },
      { type: "toggle", id: "lint" },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    const scriptIds = ["lint"];
    const started = reduceSelectedChecksControl(settled.state, {
      type: "command-start",
      spec: { kind: "run", input: { threadId: threadA, scriptIds } },
    });
    expect(started.effect).toMatchObject({
      type: "command",
      target: targetA,
      spec: { kind: "run", input: { threadId: threadA, scriptIds: ["lint"] } },
    });
    scriptIds.push("forged");
    expect(started.state.command?.spec).toEqual({
      kind: "run",
      input: { threadId: threadA, scriptIds: ["lint"] },
    });
    expect(started.state.command?.target).toEqual(targetA);
  });

  it("prunes candidates during a command without mutating the captured spec or generation", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint", "test"] },
      { type: "toggle", id: "lint" },
      { type: "toggle", id: "test" },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    const started = reduceSelectedChecksControl(settled.state, {
      type: "command-start",
      spec: { kind: "run", input: { threadId: threadA, scriptIds: ["lint", "test"] } },
    });
    const commandGen = started.state.gen;
    const pruned = reduceSelectedChecksControl(started.state, {
      type: "candidates-changed",
      ids: ["lint"],
    });
    expect(pruned.effect).toBeNull();
    expect(pruned.state.selection.ids).toEqual(["lint"]);
    expect(pruned.state.command?.gen).toBe(commandGen);
    expect(pruned.state.command?.spec).toEqual(started.state.command?.spec);
  });

  it("retags seeded edits when the same target receives a new lifecycle key", () => {
    const keyOld = '{"thread":"old"}';
    const keyNew = '{"thread":"new"}';
    const { state: seeded } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(keyOld, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint"] },
      { type: "toggle", id: "lint" },
    ]);
    expect(seeded.selection.seededFor).toBe(keyOld);

    const recreated = reduceSelectedChecksControl(seeded, lifecycle(keyNew, true));
    expect(recreated.state.selection.seededFor).toBe(keyNew);
    expect(recreated.state.selection.userEdited).toBe(true);
    expect(recreated.state.selection.ids).toEqual(["lint"]);
  });

  it("seeds once, defers empty seeds, and preserves user edits across close and reopen", () => {
    const key = '{"conn":1}';
    const { state: opened } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint", "test"] },
      openPanel(["lint", "ghost"], true),
    ]);
    expect(opened.selection.ids).toEqual(["lint"]);
    expect(opened.selection.seededFor).toBe(key);

    const edited = reduceSelectedChecksControl(opened, { type: "toggle", id: "test" });
    expect(edited.state.selection.userEdited).toBe(true);
    const closed = reduceSelectedChecksControl(edited.state, { type: "close" });
    const reopened = reduceSelectedChecksControl(closed.state, openPanel(["lint"], true));
    expect(reopened.state.selection.ids).toEqual(["lint", "test"]);
    expect(reopened.state.selection.seededFor).toBe(key);
  });

  it("preserves empty-seed user edits across close and reopen and after a later plan get", () => {
    const key = '{"conn":1}';
    const { state: opened } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint", "test"] },
      openPanel([], true),
      { type: "toggle", id: "test" },
    ]);
    expect(opened.selection.userEdited).toBe(true);
    expect(opened.selection.ids).toEqual(["test"]);
    const closed = reduceSelectedChecksControl(opened, { type: "close" });
    const reopened = reduceSelectedChecksControl(closed.state, openPanel(["lint"], true));
    expect(reopened.state.selection.ids).toEqual(["test"]);
    const settled = reduceSelectedChecksControl(reopened.state, {
      type: "get-settled",
      gen: reopened.state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(
            passingReceipt({
              planned: [
                {
                  scriptId: "lint",
                  scriptName: "Lint",
                  commandSha256: sha256,
                  timeoutMs: 60_000,
                },
              ],
            }),
          ),
        }),
      ),
    });
    expect(settled.state.selection.ids).toEqual(["test"]);
    expect(settled.state.selection.userEdited).toBe(true);
  });

  it("ignores toggles for ids that are not current candidates", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
    ]);
    const blocked = reduceSelectedChecksControl(state, { type: "toggle", id: "ghost" });
    expect(blocked.state).toBe(state);
  });

  it("defers seeding until the first successful get when the open seed was empty", () => {
    const key = '{"conn":1}';
    const { state: opened } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint", "test"] },
    ]);
    expect(opened.selection.seededFor).toBeNull();
    const settled = reduceSelectedChecksControl(opened, {
      type: "get-settled",
      gen: opened.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    expect(settled.state.selection.ids).toEqual(["lint", "test"]);
    expect(settled.state.selection.seededFor).toBe(key);
  });

  it("enforces the selection cap and always allows deselect", () => {
    const key = '{"conn":1}';
    const ids = Array.from({ length: SELECTED_CHECK_MAX }, (_, index) => `check-${index}`);
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: [...ids, "overflow"] },
      ...ids.map((id) => ({ type: "toggle" as const, id })),
    ]);
    expect(state.selection.ids).toHaveLength(SELECTED_CHECK_MAX);
    const blocked = reduceSelectedChecksControl(state, { type: "toggle", id: "overflow" });
    expect(blocked.state.selection.ids).toHaveLength(SELECTED_CHECK_MAX);
    const deselected = reduceSelectedChecksControl(blocked.state, {
      type: "toggle",
      id: ids[0]!,
    });
    expect(deselected.state.selection.ids).toHaveLength(SELECTED_CHECK_MAX - 1);
  });

  it("surfaces run mismatch without fabricating chronology and ends cancel-false without a terminal verdict", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    const run = reduceSelectedChecksControl(settled.state, {
      type: "command-start",
      spec: { kind: "run", input: { threadId: threadA, scriptIds: ["lint"] } },
    });
    const runSettled = reduceSelectedChecksControl(run.state, {
      type: "command-settled",
      gen: run.state.gen,
      outcome: { kind: "run-ok", attemptId: "expected-attempt" },
    });
    expect(runSettled.state.pendingRun).toEqual({ attemptId: "expected-attempt" });
    const starting = deriveSelectedChecksView(viewInput(runSettled.state));
    expect(starting.headline).toBe("starting");
    expect(starting.headline).not.toBe("passed");
    expect(starting.pendingRunAttemptId).toBe("expected-attempt");

    const receiptY = passingReceipt({ attemptId: "other-attempt" });
    const mismatch = reduceSelectedChecksControl(runSettled.state, {
      type: "get-settled",
      gen: runSettled.state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(receiptY),
        }),
      ),
    });
    expect(mismatch.state.pendingRun).toBeNull();
    expect(mismatch.state.notice).toEqual({ key: "run-superseded" });
    const displayed = deriveSelectedChecksView(viewInput(mismatch.state));
    expect(displayed.recordAuthority).toBe("current");
    expect(displayed.record?.receipt.attemptId).toBe("other-attempt");
    expect(displayed.headline).toBe("passed");

    const cancel = reduceSelectedChecksControl(mismatch.state, {
      type: "command-start",
      spec: {
        kind: "cancel",
        input: { threadId: threadA, attemptId: "other-attempt" },
      },
    });
    const cancelSettled = reduceSelectedChecksControl(cancel.state, {
      type: "command-settled",
      gen: cancel.state.gen,
      outcome: { kind: "cancel-ok", cancelled: false },
    });
    expect(cancelSettled.state.notice).toEqual({ key: "cancel-no-match" });
    expect(deriveSelectedChecksView(viewInput(cancelSettled.state)).headline).not.toBe("passed");
  });

  it("records unknown command outcomes without synthesizing a server terminal state", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint"] },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    const started = reduceSelectedChecksControl(settled.state, {
      type: "command-start",
      spec: { kind: "run", input: { threadId: threadA, scriptIds: ["lint"] } },
    });
    const unknown = reduceSelectedChecksControl(started.state, {
      type: "command-settled",
      gen: started.state.gen,
      outcome: { kind: "unknown" },
    });
    expect(unknown.state.notice).toEqual({ key: "start-unconfirmed" });
    expect(unknown.effect?.type).toBe("get");
    expect(deriveSelectedChecksView(viewInput(unknown.state)).headline).toBe("unknown");
  });

  it("settles the current get on error instead of staying loading forever", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
    ]);
    const failed = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: { kind: "error", message: "interrupted" },
    });
    expect(failed.state.get.phase).toBe("settled");
    expect(deriveSelectedChecksView(viewInput(failed.state)).getInFlight).toBe(false);
    expect(deriveSelectedChecksView(viewInput(failed.state)).headline).toBe("error");
  });

  it("treats focus refresh like a bounded manual refresh while open", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
    ]);
    const refreshed = reduceSelectedChecksControl(state, { type: "focus-refresh" });
    expect(refreshed.effect?.type).toBe("get");
    expect(refreshed.state.get.phase).toBe("loading");
  });

  it("arms at most one automatic refresh per live terminal key", () => {
    const key = '{"conn":1}';
    const receipt = passingReceipt({ attemptId: "live-attempt", revision: 4, phase: "completed" });
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(receipt) })),
    });
    const terminalKey = "live-attempt:4";
    const first = reduceSelectedChecksControl(settled.state, {
      type: "live-terminal",
      key: terminalKey,
    });
    expect(first.effect?.type).toBe("get");
    const reconciledNone = reduceSelectedChecksControl(first.state, {
      type: "get-settled",
      gen: first.state.gen,
      outcome: okOutcome(decodeGetResult({ record: { kind: "none" } })),
    });
    expect(deriveSelectedChecksView(viewInput(reconciledNone.state)).headline).toBe("none");
    const afterNone = reduceSelectedChecksControl(reconciledNone.state, {
      type: "live-terminal",
      key: terminalKey,
    });
    expect(afterNone.effect).toBeNull();

    const reconciledMalformed = reduceSelectedChecksControl(first.state, {
      type: "get-settled",
      gen: first.state.gen,
      outcome: okOutcome(decodeGetResult({ record: { kind: "malformed" } })),
    });
    expect(deriveSelectedChecksView(viewInput(reconciledMalformed.state)).headline).toBe(
      "unreadable",
    );
    expect(
      reduceSelectedChecksControl(reconciledMalformed.state, {
        type: "live-terminal",
        key: terminalKey,
      }).effect,
    ).toBeNull();
  });

  it.each([
    {
      label: "run",
      start: {
        type: "command-start" as const,
        spec: { kind: "run" as const, input: { threadId: threadA, scriptIds: ["lint"] } },
      },
      settled: { kind: "run-ok" as const, attemptId: "attempt-run" },
      staleOutcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission: { state: "open" },
        }),
      ),
    },
    {
      label: "cancel",
      start: {
        type: "command-start" as const,
        spec: {
          kind: "cancel" as const,
          input: { threadId: threadA, attemptId: "attempt-a" },
        },
      },
      settled: { kind: "cancel-ok" as const, cancelled: true },
      staleOutcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission: { state: "open" },
        }),
      ),
    },
    {
      label: "resolve",
      start: {
        type: "command-start" as const,
        spec: {
          kind: "resolve" as const,
          input: { markerSha256: sha256, acknowledgeUncertainty: true },
        },
      },
      settled: {
        kind: "resolve-ok" as const,
        outcome: "acknowledged" as const,
        admission: { state: "open" as const },
      },
      staleOutcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission: {
            state: "owner-unresolved",
            marker: {
              sha256,
              attemptId: "attempt-a",
              threadId: threadA,
              scriptId: "lint",
              pgid: 1,
              writtenAt: "2026-08-20T12:00:00Z",
            },
          },
        }),
      ),
    },
  ])(
    "ignores a pre-command get completion after $label starts and only the following get restores authority",
    ({ start, settled, staleOutcome }) => {
      const key = '{"conn":1}';
      const { state } = reduceChain(initialSelectedChecksControl(), [
        lifecycle(key, true),
        { type: "candidates-changed", ids: ["lint"] },
        openPanel([], true),
      ]);
      const firstGetGen = state.gen;
      const accepted = reduceSelectedChecksControl(state, {
        type: "get-settled",
        gen: firstGetGen,
        outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
      });
      const started = reduceSelectedChecksControl(accepted.state, start);
      const commandGen = started.state.gen;
      const staleDuringCommand = reduceSelectedChecksControl(started.state, {
        type: "get-settled",
        gen: firstGetGen,
        outcome: staleOutcome,
      });
      expect(staleDuringCommand.state).toBe(started.state);
      expect(staleDuringCommand.effect).toBeNull();
      expect(deriveSelectedChecksView(viewInput(staleDuringCommand.state)).canRun).toBe(false);

      const commandDone = reduceSelectedChecksControl(started.state, {
        type: "command-settled",
        gen: commandGen,
        outcome: settled,
      });
      expect(commandDone.effect).toMatchObject({ type: "get", gen: commandGen + 1 });
      const staleAfterRefresh = reduceSelectedChecksControl(commandDone.state, {
        type: "get-settled",
        gen: firstGetGen,
        outcome: staleOutcome,
      });
      expect(staleAfterRefresh.state).toBe(commandDone.state);
      expect(staleAfterRefresh.effect).toBeNull();

      const fresh = reduceSelectedChecksControl(commandDone.state, {
        type: "get-settled",
        gen: commandDone.state.gen,
        outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
      });
      expect(deriveSelectedChecksView(viewInput(fresh.state)).hasCurrentAuthority).toBe(true);
    },
  );

  it("ignores stale command-settled after lifecycle invalidation while a successor command stays intact", () => {
    const keyA = '{"conn":1}';
    const keyB = '{"conn":2}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(keyA, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    const first = reduceSelectedChecksControl(settled.state, {
      type: "command-start",
      spec: { kind: "run", input: { threadId: threadA, scriptIds: ["lint"] } },
    });
    const firstGen = first.state.gen;
    const invalidated = reduceSelectedChecksControl(first.state, lifecycle(keyB, true));
    const successor = reduceSelectedChecksControl(invalidated.state, {
      type: "command-start",
      spec: { kind: "cancel", input: { threadId: threadA, attemptId: "attempt-a" } },
    });
    const staleCommand = reduceSelectedChecksControl(successor.state, {
      type: "command-settled",
      gen: firstGen,
      outcome: { kind: "run-ok", attemptId: "stale-attempt" },
    });
    expect(staleCommand.state).toBe(successor.state);
    expect(staleCommand.effect).toBeNull();
    expect(staleCommand.state.pendingRun).toBeNull();
    expect(staleCommand.state.notice).toBeNull();

    const successorDone = reduceSelectedChecksControl(successor.state, {
      type: "command-settled",
      gen: successor.state.gen,
      outcome: { kind: "cancel-ok", cancelled: true },
    });
    expect(successorDone.state.notice).toEqual({ key: "cancel-requested" });
    expect(successorDone.effect?.type).toBe("get");
  });

  it("clears pending run as run-unavailable on none and surfaces failed post-run gets", () => {
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
      { type: "toggle", id: "lint" },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(passingReceipt()) })),
    });
    const run = reduceSelectedChecksControl(settled.state, {
      type: "command-start",
      spec: { kind: "run", input: { threadId: threadA, scriptIds: ["lint"] } },
    });
    const runSettled = reduceSelectedChecksControl(run.state, {
      type: "command-settled",
      gen: run.state.gen,
      outcome: { kind: "run-ok", attemptId: "expected-attempt" },
    });
    const none = reduceSelectedChecksControl(runSettled.state, {
      type: "get-settled",
      gen: runSettled.state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: { kind: "none" },
          admission: { state: "open" },
        }),
      ),
    });
    expect(none.state.pendingRun).toBeNull();
    expect(none.state.notice).toEqual({ key: "run-unavailable" });
    const noneView = deriveSelectedChecksView(viewInput(none.state, { candidateIds: ["lint"] }));
    expect(noneView.headline).toBe("none");
    expect(noneView.record).toBeNull();
    expect(noneView.canRun).toBe(true);

    const runAgain = reduceSelectedChecksControl(none.state, {
      type: "command-start",
      spec: { kind: "run", input: { threadId: threadA, scriptIds: ["lint"] } },
    });
    const pendingAgain = reduceSelectedChecksControl(runAgain.state, {
      type: "command-settled",
      gen: runAgain.state.gen,
      outcome: { kind: "run-ok", attemptId: "retry-attempt" },
    });
    const failed = reduceSelectedChecksControl(pendingAgain.state, {
      type: "get-settled",
      gen: pendingAgain.state.gen,
      outcome: { kind: "error", message: "network" },
    });
    expect(failed.state.pendingRun).toEqual({ attemptId: "retry-attempt" });
    const failedView = deriveSelectedChecksView(viewInput(failed.state));
    expect(failedView.getInFlight).toBe(false);
    expect(failedView.headline).toBe("error");
    expect(failedView.canRun).toBe(false);
  });
});

describe("deriveSelectedChecksView", () => {
  it("shows previous record for display only and blocks mutations until a current get exists", () => {
    const key = '{"conn":1}';
    const receipt = passingReceipt();
    let control = initialSelectedChecksControl();
    ({ state: control } = reduceSelectedChecksControl(control, lifecycle(key, true)));
    ({ state: control } = reduceSelectedChecksControl(control, openPanel([], true)));
    ({ state: control } = reduceSelectedChecksControl(control, {
      type: "candidates-changed",
      ids: ["lint", "test"],
    }));
    const settled = reduceSelectedChecksControl(control, {
      type: "get-settled",
      gen: control.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(receipt) })),
    });
    const refreshed = reduceSelectedChecksControl(settled.state, { type: "manual-refresh" });
    const withPrevious = deriveSelectedChecksView(
      viewInput(refreshed.state, {
        live: null,
      }),
    );
    expect(withPrevious.recordAuthority).toBe("previous");
    expect(withPrevious.comparisonStale).toBe(true);
    expect(withPrevious.canRun).toBe(false);
    expect(withPrevious.canStop).toBe(false);
    expect(withPrevious.canRecover).toBe(false);
  });

  it("does not treat resolveSeen as sufficient for canRun or dialog submit", () => {
    const key = '{"conn":1}';
    const markerSha = "c".repeat(64);
    const ownerAdmission = {
      state: "owner-unresolved" as const,
      marker: {
        sha256: markerSha,
        attemptId: "attempt-a",
        threadId: threadA,
        scriptId: "lint",
        pgid: 1,
        writtenAt: "2026-08-20T12:00:00Z",
      },
    };
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
      { type: "toggle", id: "lint" },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission: ownerAdmission,
        }),
      ),
    });
    const resolved = reduceSelectedChecksControl(settled.state, {
      type: "command-start",
      spec: { kind: "resolve", input: { markerSha256: markerSha, acknowledgeUncertainty: true } },
    });
    const resolveSettled = reduceSelectedChecksControl(resolved.state, {
      type: "command-settled",
      gen: resolved.state.gen,
      outcome: {
        kind: "resolve-ok",
        outcome: "still-unresolved",
        admission: ownerAdmission,
      },
    });
    const pending = deriveSelectedChecksView(viewInput(resolveSettled.state));
    expect(pending.admission?.state).toBe("owner-unresolved");
    expect(pending.canRun).toBe(false);
    const dialogOpened = reduceSelectedChecksControl(resolveSettled.state, {
      type: "dialog-open",
      state: "owner-unresolved",
      sha256: markerSha,
    });
    const withDialog = deriveSelectedChecksView(viewInput(dialogOpened.state));
    expect(withDialog.dialogSubmit?.allowed).toBe(false);

    const failedGet = reduceSelectedChecksControl(dialogOpened.state, {
      type: "get-settled",
      gen: dialogOpened.state.gen,
      outcome: { kind: "error", message: "failed" },
    });
    const afterError = deriveSelectedChecksView(
      viewInput(failedGet.state, { candidateIds: ["lint"] }),
    );
    expect(afterError.canRun).toBe(false);
    expect(afterError.dialogSubmit?.allowed).toBe(false);

    const refreshed = reduceSelectedChecksControl(failedGet.state, { type: "manual-refresh" });
    const positive = reduceSelectedChecksControl(refreshed.state, {
      type: "get-settled",
      gen: refreshed.state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission: { state: "open" },
        }),
      ),
    });
    const allowed = deriveSelectedChecksView(viewInput(positive.state, { candidateIds: ["lint"] }));
    expect(allowed.canRun).toBe(true);

    const { state: openSeenState } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
      { type: "toggle", id: "lint" },
    ]);
    const openSeenSettled = reduceSelectedChecksControl(openSeenState, {
      type: "get-settled",
      gen: openSeenState.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission: ownerAdmission,
        }),
      ),
    });
    const openResolve = reduceSelectedChecksControl(openSeenSettled.state, {
      type: "command-start",
      spec: { kind: "resolve", input: { markerSha256: markerSha, acknowledgeUncertainty: true } },
    });
    const openResolveSettled = reduceSelectedChecksControl(openResolve.state, {
      type: "command-settled",
      gen: openResolve.state.gen,
      outcome: {
        kind: "resolve-ok",
        outcome: "acknowledged",
        admission: { state: "open" },
      },
    });
    const openPending = deriveSelectedChecksView(
      viewInput(openResolveSettled.state, { candidateIds: ["lint"] }),
    );
    expect(openPending.admission?.state).toBe("open");
    expect(openPending.canRun).toBe(false);

    const openFailed = reduceSelectedChecksControl(openResolveSettled.state, {
      type: "get-settled",
      gen: openResolveSettled.state.gen,
      outcome: { kind: "error", message: "failed" },
    });
    expect(
      deriveSelectedChecksView(viewInput(openFailed.state, { candidateIds: ["lint"] })).canRun,
    ).toBe(false);

    const openRefreshed = reduceSelectedChecksControl(openFailed.state, { type: "manual-refresh" });
    const openPositive = reduceSelectedChecksControl(openRefreshed.state, {
      type: "get-settled",
      gen: openRefreshed.state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission: { state: "open" },
        }),
      ),
    });
    expect(
      deriveSelectedChecksView(viewInput(openPositive.state, { candidateIds: ["lint"] })).canRun,
    ).toBe(true);

    const ownerDialogOpened = reduceSelectedChecksControl(openSeenSettled.state, {
      type: "dialog-open",
      state: "owner-unresolved",
      sha256: markerSha,
    });
    const ownerAllowed = deriveSelectedChecksView(viewInput(ownerDialogOpened.state));
    expect(ownerAllowed.dialogSubmit?.allowed).toBe(true);
    expect(ownerAllowed.dialogSubmit?.input).toEqual({
      markerSha256: markerSha,
      acknowledgeUncertainty: true,
    });
  });

  it("prefers authoritative none and malformed results over newer live hints", () => {
    const runningLive = passingReceipt({
      attemptId: "live-running",
      revision: 1,
      phase: "running",
    });
    const completedLive = passingReceipt({
      attemptId: "live-done",
      revision: 5,
      phase: "completed",
    });
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
    ]);
    const none = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: { kind: "none" } })),
    });
    const noneView = deriveSelectedChecksView(
      viewInput(none.state, {
        live: { receipt: { ...completedLive, revision: 99 }, sequence: 100 },
      }),
    );
    expect(noneView.headline).toBe("none");
    expect(noneView.record).toBeNull();
    expect(noneView.liveIsNewer).toBe(false);

    const malformed = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: { kind: "malformed" } })),
    });
    const malformedView = deriveSelectedChecksView(
      viewInput(malformed.state, {
        live: { receipt: completedLive, sequence: 50 },
      }),
    );
    expect(malformedView.headline).toBe("unreadable");
    expect(malformedView.record).toBeNull();
    expect(malformedView.liveIsNewer).toBe(false);

    const present = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt({ attemptId: "current", revision: 1 }), 3),
        }),
      ),
    });
    const awaiting = deriveSelectedChecksView(
      viewInput(present.state, {
        live: { receipt: completedLive, sequence: 4 },
      }),
    );
    expect(awaiting.headline).toBe("awaiting-confirmation");
    expect(awaiting.headline).not.toBe("passed");
  });

  it("treats a newer running live hint as newer for display comparisons", () => {
    const runningLive = passingReceipt({
      attemptId: "live-running",
      revision: 1,
      phase: "running",
    });
    const key = '{"conn":1}';
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
    ]);
    const none = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: { kind: "none" } })),
    });
    const runningHint = deriveSelectedChecksView(
      viewInput(none.state, {
        live: { receipt: runningLive, sequence: 1 },
      }),
    );
    expect(runningHint.liveIsNewer).toBe(false);
    expect(runningHint.headline).toBe("none");
  });

  it("pairs newer live running display with the live stop attempt id and empty changed scripts", () => {
    const key = '{"conn":1}';
    const currentReceipt = passingReceipt({ attemptId: "current", revision: 1 });
    const liveReceipt = passingReceipt({
      attemptId: "live",
      revision: 3,
      phase: "running",
      endedAt: null,
    });
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(currentReceipt, 10),
          changedScriptIds: ["lint"],
        }),
      ),
    });
    const view = deriveSelectedChecksView(
      viewInput(settled.state, {
        live: { receipt: liveReceipt, sequence: 11 },
      }),
    );
    expect(view.headline).toBe("running");
    expect(view.recordAuthority).toBe("live");
    expect(view.record?.receipt.attemptId).toBe("live");
    expect(view.stopAttemptId).toBe("live");
    expect(view.canStop).toBe(true);
    expect(view.changedScriptIds).toEqual([]);
    expect(view.derived).toBeNull();
  });

  it("derives passed only from a current present record via deriveSelectedCheckState", () => {
    const key = '{"conn":1}';
    const receipt = passingReceipt();
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint", "test"] },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(receipt) })),
    });
    const view = deriveSelectedChecksView(viewInput(settled.state));
    expect(view.headline).toBe("passed");
    expect(view.derived).toEqual(deriveSelectedCheckState(presentRecord(receipt)));
  });

  it("blocks mutations for permission, connection, and capability restrictions", () => {
    const key = '{"conn":1}';
    const runningReceipt = passingReceipt({
      attemptId: "running",
      phase: "running",
      endedAt: null,
      checks: [
        {
          scriptId: "lint",
          status: "running",
          startedAt: "2026-08-20T12:00:00Z",
          endedAt: null,
          exitCode: null,
          exitedBy: null,
          exitSignal: null,
          pgid: 41234,
          group: "not-started",
          stdout: null,
          stderr: null,
          failure: null,
        },
      ],
    });
    const corruptAdmission = {
      state: "owner-corrupt" as const,
      marker: { sha256: "b".repeat(64), bytes: 128 },
    };
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      { type: "candidates-changed", ids: ["lint"] },
      openPanel([], true),
      { type: "toggle", id: "lint" },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(runningReceipt),
          admission: corruptAdmission,
        }),
      ),
    });
    const allowed = deriveSelectedChecksView(
      viewInput(settled.state, { permission: "allowed", connected: true, candidateIds: ["lint"] }),
    );
    expect(allowed.canStop).toBe(true);
    expect(allowed.canRecover).toBe(true);
    expect(allowed.canRun).toBe(false);

    const denied = deriveSelectedChecksView(
      viewInput(settled.state, { permission: "read-only", connected: true }),
    );
    expect(denied.canRun).toBe(false);
    expect(denied.canStop).toBe(false);
    expect(denied.canRecover).toBe(false);
    const unknown = deriveSelectedChecksView(
      viewInput(settled.state, { permission: "unknown", connected: true }),
    );
    expect(unknown.canRun).toBe(false);
    expect(unknown.canStop).toBe(false);
    const offline = deriveSelectedChecksView(
      viewInput(settled.state, { permission: "allowed", connected: false }),
    );
    expect(offline.canRun).toBe(false);
    expect(offline.canStop).toBe(false);
    const capabilityBlocked = deriveSelectedChecksView(
      viewInput(settled.state, {
        control: {
          ...settled.state,
          get: {
            gen: settled.state.gen,
            phase: "settled",
            outcome: {
              kind: "ok",
              result: decodeGetResult({
                record: presentRecord(runningReceipt),
                capability: { available: false, reason: "not-posix" },
                admission: corruptAdmission,
              }),
            },
          },
        },
        candidateIds: ["lint"],
      }),
    );
    expect(capabilityBlocked.canRun).toBe(false);
    expect(capabilityBlocked.canStop).toBe(true);
    expect(capabilityBlocked.canRecover).toBe(true);

    for (const available of [true, false]) {
      const fresh = reduceSelectedChecksControl(settled.state, { type: "manual-refresh" });
      const result = reduceSelectedChecksControl(fresh.state, {
        type: "get-settled",
        gen: fresh.state.gen,
        outcome: okOutcome(
          decodeGetResult({
            record: { kind: "none" },
            admission: { state: "open" },
            capability: { available, reason: available ? null : "not-posix" },
          }),
        ),
      });
      const view = deriveSelectedChecksView(viewInput(result.state, { candidateIds: ["lint"] }));
      expect(view.canRun).toBe(available);
    }

    const recoverOnly = deriveSelectedChecksView(
      viewInput(settled.state, {
        candidateIds: [],
        control: {
          ...settled.state,
          get: {
            gen: settled.state.gen,
            phase: "settled",
            outcome: {
              kind: "ok",
              result: decodeGetResult({
                record: { kind: "malformed" },
                admission: corruptAdmission,
              }),
            },
          },
        },
      }),
    );
    expect(recoverOnly.canRun).toBe(false);
    expect(recoverOnly.canRecover).toBe(true);
  });

  it("requires every dialog binding field before submit is allowed", () => {
    const key = '{"conn":1}';
    const markerSha = "d".repeat(64);
    const admission = {
      state: "owner-unresolved" as const,
      marker: {
        sha256: markerSha,
        attemptId: "attempt-a",
        threadId: threadA,
        scriptId: "lint",
        pgid: 1,
        writtenAt: "2026-08-20T12:00:00Z",
      },
    };
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission,
        }),
      ),
    });
    const opened = reduceSelectedChecksControl(settled.state, {
      type: "dialog-open",
      state: "owner-unresolved",
      sha256: markerSha,
    });
    const allowed = deriveSelectedChecksView(viewInput(opened.state));
    expect(allowed.dialogSubmit?.allowed).toBe(true);
    expect(allowed.dialogSubmit?.input).toEqual({
      markerSha256: markerSha,
      acknowledgeUncertainty: true,
    });

    const lifecycleDrift = reduceSelectedChecksControl(opened.state, lifecycle('{"conn":2}', true));
    expect(lifecycleDrift.state.dialog).toBeNull();
    const driftView = deriveSelectedChecksView(viewInput(lifecycleDrift.state));
    expect(driftView.dialog).toBeNull();
    expect(driftView.dialogSubmit).toBeNull();

    const refreshed = reduceSelectedChecksControl(opened.state, { type: "manual-refresh" });
    const sameOwner = reduceSelectedChecksControl(refreshed.state, {
      type: "get-settled",
      gen: refreshed.state.gen,
      outcome: okOutcome(
        decodeGetResult({
          record: presentRecord(passingReceipt()),
          admission,
        }),
      ),
    });
    const genDrift = deriveSelectedChecksView(viewInput(sameOwner.state));
    expect(genDrift.dialogSubmit?.allowed).toBe(false);

    const stateMismatch = reduceSelectedChecksControl(settled.state, {
      type: "dialog-open",
      state: "owner-corrupt",
      sha256: markerSha,
    });
    expect(deriveSelectedChecksView(viewInput(stateMismatch.state)).dialogSubmit?.allowed).toBe(
      false,
    );

    const shaDrift = reduceSelectedChecksControl(settled.state, {
      type: "dialog-open",
      state: "owner-unresolved",
      sha256: "e".repeat(64),
    });
    const shaView = deriveSelectedChecksView(viewInput(shaDrift.state));
    expect(shaView.dialogSubmit?.allowed).toBe(false);

    const offlineDialog = deriveSelectedChecksView(
      viewInput(opened.state, { permission: "allowed", connected: false }),
    );
    expect(offlineDialog.dialogSubmit?.allowed).toBe(false);
  });

  it("requires every selected id to be a current candidate for canRun", () => {
    const key = '{"conn":1}';
    const receipt = passingReceipt();
    const { state } = reduceChain(initialSelectedChecksControl(), [
      lifecycle(key, true),
      openPanel([], true),
      { type: "candidates-changed", ids: ["lint", "test"] },
      { type: "toggle", id: "lint" },
      { type: "toggle", id: "test" },
    ]);
    const settled = reduceSelectedChecksControl(state, {
      type: "get-settled",
      gen: state.gen,
      outcome: okOutcome(decodeGetResult({ record: presentRecord(receipt) })),
    });
    const allowed = deriveSelectedChecksView(
      viewInput(settled.state, { candidateIds: ["lint", "test"] }),
    );
    expect(allowed.canRun).toBe(true);
    const pruned = deriveSelectedChecksView(viewInput(settled.state, { candidateIds: ["lint"] }));
    expect(pruned.canRun).toBe(false);
  });
});
