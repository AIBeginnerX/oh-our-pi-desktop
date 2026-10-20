import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { ProjectMemoryRejectedError, type ProjectMemoryThreadState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  canConfirmAcknowledge,
  isTaggedError,
  latestTurnStartFailureId,
  recoveryScopeKey,
  recoveryView,
  sanitizeUnsentPrompt,
} from "./ProjectMemoryRecovery.logic";

const defaultThreadState = (): ProjectMemoryThreadState => ({
  held: true,
  latestChangeSeq: 5,
  acknowledgedThrough: 0,
  changes: [{ changeSeq: 5, reason: "updated" }],
  mayHaveMore: false,
});

const threadState = (
  overrides: Partial<ProjectMemoryThreadState> = {},
): ProjectMemoryThreadState => ({
  ...defaultThreadState(),
  ...overrides,
});

const failure = (error: unknown) =>
  AsyncResult.failure<ProjectMemoryThreadState, unknown>(Cause.fail(error));
const threadMissing = () => failure(new ProjectMemoryRejectedError({ reason: "thread-missing" }));

describe("recoveryScopeKey", () => {
  it("binds the full environment/project/thread tuple", () => {
    expect(recoveryScopeKey("env-a", "project-a", "thread-a")).toBe(
      JSON.stringify(["env-a", "project-a", "thread-a"]),
    );
    expect(recoveryScopeKey("env-a", "project-a", "thread-a")).not.toBe(
      recoveryScopeKey("env-b", "project-a", "thread-a"),
    );
    expect(recoveryScopeKey("env-a", "project-a", "thread-a")).not.toBe(
      recoveryScopeKey("env-a", "project-b", "thread-a"),
    );
    expect(recoveryScopeKey("env-a", "project-a", "thread-a")).not.toBe(
      recoveryScopeKey("env-a", "project-a", "thread-b"),
    );
  });
});

describe("recoveryView", () => {
  it("reports unsupported without capability regardless of the read", () => {
    expect(
      recoveryView({ supported: false, result: AsyncResult.success(threadState()), wasHeld: true }),
    ).toEqual({ kind: "unsupported" });
  });

  it("shows nothing while pending unless the scope was held before", () => {
    expect(
      recoveryView({ supported: true, result: AsyncResult.initial(false), wasHeld: false }),
    ).toEqual({ kind: "none" });
    expect(
      recoveryView({ supported: true, result: AsyncResult.initial(true), wasHeld: false }),
    ).toEqual({ kind: "none" });
    expect(
      recoveryView({ supported: true, result: AsyncResult.initial(true), wasHeld: true }),
    ).toEqual({ kind: "checking" });
    expect(
      recoveryView({
        supported: true,
        result: AsyncResult.success(threadState(), { waiting: true }),
        wasHeld: true,
      }),
    ).toEqual({ kind: "checking" });
  });

  it("treats the typed thread-missing rejection as nothing to recover", () => {
    expect(recoveryView({ supported: true, result: threadMissing(), wasHeld: true })).toEqual({
      kind: "none",
    });
  });

  it("shows a generic error for every other failure without echoing messages", () => {
    expect(
      recoveryView({
        supported: true,
        result: failure(new ProjectMemoryRejectedError({ reason: "sensitive" })),
        wasHeld: true,
      }),
    ).toEqual({ kind: "error" });
    expect(
      recoveryView({ supported: true, result: failure(new Error("boom")), wasHeld: false }),
    ).toEqual({ kind: "error" });
  });

  it("clears on a held:false success", () => {
    expect(
      recoveryView({
        supported: true,
        result: AsyncResult.success(threadState({ held: false, latestChangeSeq: null })),
        wasHeld: true,
      }),
    ).toEqual({ kind: "none" });
  });

  it("cannot describe a held scope without a latest change", () => {
    expect(
      recoveryView({
        supported: true,
        result: AsyncResult.success(threadState({ latestChangeSeq: null })),
        wasHeld: false,
      }),
    ).toEqual({ kind: "error" });
  });

  it("counts shown rows by reason and carries the watermark and page flag", () => {
    expect(
      recoveryView({
        supported: true,
        result: AsyncResult.success(
          threadState({
            latestChangeSeq: 9,
            changes: [
              { changeSeq: 9, reason: "updated" },
              { changeSeq: 8, reason: "updated" },
              { changeSeq: 7, reason: "deleted" },
            ],
            mayHaveMore: true,
          }),
        ),
        wasHeld: false,
      }),
    ).toEqual({
      kind: "held",
      latestChangeSeq: 9,
      shown: 3,
      updated: 2,
      deleted: 1,
      mayHaveMore: true,
    });
  });
});

describe("canConfirmAcknowledge", () => {
  const view = (overrides: Record<string, unknown> = {}) => ({
    kind: "held",
    latestChangeSeq: 7,
    shown: 1,
    updated: 1,
    deleted: 0,
    mayHaveMore: false,
    ...overrides,
  });
  const captured = { scopeKey: '["env-a","project-a","thread-a"]', seq: 7 };

  it("accepts the matching captured consent", () => {
    expect(
      canConfirmAcknowledge(captured, {
        scopeKey: captured.scopeKey,
        supported: true,
        view: view() as never,
      }),
    ).toBe(true);
  });

  it("rejects a null capture, another scope with the same seq, and seq drift", () => {
    expect(
      canConfirmAcknowledge(null, {
        scopeKey: captured.scopeKey,
        supported: true,
        view: view() as never,
      }),
    ).toBe(false);
    expect(
      canConfirmAcknowledge(captured, {
        scopeKey: '["env-b","project-a","thread-a"]',
        supported: true,
        view: view() as never,
      }),
    ).toBe(false);
    expect(
      canConfirmAcknowledge(
        { ...captured, seq: 8 },
        {
          scopeKey: captured.scopeKey,
          supported: true,
          view: view() as never,
        },
      ),
    ).toBe(false);
    expect(
      canConfirmAcknowledge(captured, {
        scopeKey: captured.scopeKey,
        supported: true,
        view: view({ latestChangeSeq: 9 }) as never,
      }),
    ).toBe(false);
  });

  it("rejects pending, cleared, errored views and lost capability", () => {
    for (const current of [
      { scopeKey: captured.scopeKey, supported: true, view: { kind: "checking" } },
      { scopeKey: captured.scopeKey, supported: true, view: { kind: "none" } },
      { scopeKey: captured.scopeKey, supported: true, view: { kind: "error" } },
      { scopeKey: captured.scopeKey, supported: false, view: view() },
    ]) {
      expect(canConfirmAcknowledge(captured, current as never)).toBe(false);
    }
  });
});

describe("sanitizeUnsentPrompt", () => {
  it("removes recognized memory references entirely", () => {
    expect(sanitizeUnsentPrompt("Fix [Project memory](t3-context://v1/memory/m1)")).toBe("Fix");
    expect(sanitizeUnsentPrompt("[Project memory](t3-context://v1/memory/m1) now")).toBe("now");
  });

  it("collapses other recognized references to their labels", () => {
    expect(
      sanitizeUnsentPrompt(
        "Check [report.pdf](t3-context://v1/file/f1) and [term](t3-context://v1/terminal/t1)",
      ),
    ).toBe("Check report.pdf and term");
  });

  it("leaves ordinary prose and malformed links untouched, then trims", () => {
    expect(sanitizeUnsentPrompt("  hello [a](https://example.com) world  ")).toBe(
      "hello [a](https://example.com) world",
    );
    expect(sanitizeUnsentPrompt("   ")).toBe("");
  });
});

describe("latestTurnStartFailureId", () => {
  it("is null without any turn-start failure", () => {
    expect(latestTurnStartFailureId([])).toBe(null);
    expect(latestTurnStartFailureId([{ id: "a", kind: "tool.completed" }])).toBe(null);
  });

  it("picks the last matching activity in order", () => {
    expect(
      latestTurnStartFailureId([
        { id: "a", kind: "tool.completed" },
        { id: "b", kind: "provider.turn.start.failed" },
        { id: "c", kind: "context-window.updated" },
        { id: "d", kind: "provider.turn.start.failed" },
      ]),
    ).toBe("d");
  });
});

describe("isTaggedError", () => {
  it("matches only the exact tag on tagged objects", () => {
    expect(
      isTaggedError({ _tag: "EnvironmentAuthorizationError" }, "EnvironmentAuthorizationError"),
    ).toBe(true);
    expect(isTaggedError({ _tag: "Other" }, "EnvironmentAuthorizationError")).toBe(false);
    expect(isTaggedError(null, "EnvironmentAuthorizationError")).toBe(false);
    expect(isTaggedError("EnvironmentAuthorizationError", "EnvironmentAuthorizationError")).toBe(
      false,
    );
  });
});
