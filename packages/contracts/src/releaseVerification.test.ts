import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";
import { ClientOrchestrationCommand } from "./orchestration.ts";
import {
  RELEASE_VERIFICATION_ERROR_MAX_LENGTH,
  RELEASE_VERIFICATION_REQUIRED_CHECKS,
  RELEASE_VERIFICATION_REQUIREMENT,
  ReleaseVerificationAttempt,
  type ReleaseVerificationCapability,
  type ReleaseVerificationCheck,
  type ReleaseVerificationCheckId,
  ReleaseVerificationCancelInput,
  ReleaseVerificationGetResult,
  ReleaseVerificationRunInput,
  deriveReleaseVerificationState,
  releaseVerificationActivityId,
} from "./releaseVerification.ts";

const at = "2026-08-20T12:00:00.000Z";
const threadId = ThreadId.make("thread-1");

const check = (
  id: ReleaseVerificationCheckId,
  status: ReleaseVerificationCheck["status"] = "passed",
): ReleaseVerificationCheck => ({
  id,
  status,
  startedAt: at,
  endedAt: at,
  exitCode: status === "passed" ? 0 : null,
  detail: null,
  tail: [],
});

const attempt = (
  overrides: Partial<ReleaseVerificationAttempt> = {},
): ReleaseVerificationAttempt => ({
  threadId,
  attemptId: "attempt-1",
  revision: 4,
  requirement: {
    id: RELEASE_VERIFICATION_REQUIREMENT.id,
    version: RELEASE_VERIFICATION_REQUIREMENT.version,
  },
  checkSet: [...RELEASE_VERIFICATION_REQUIRED_CHECKS],
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.0.0",
    serverVersion: "0.0.45",
  },
  artifact: {
    workspaceRoot: "/work/oop",
    relativePath: "release/macos/OoP-0.0.45-arm64.dmg",
    fileName: "OoP-0.0.45-arm64.dmg",
    appVersion: "0.0.45",
    sha256: "a".repeat(64),
    size: 1024,
    ino: 7,
    mtimeMs: 1_700_000_000_000.5,
  },
  runDir: null,
  phase: "completed",
  checks: RELEASE_VERIFICATION_REQUIRED_CHECKS.map((id) => check(id)),
  startedAt: at,
  endedAt: at,
  error: null,
  ...overrides,
});

const available: ReleaseVerificationCapability = { available: true, reason: null };

const derive = (
  value: ReleaseVerificationAttempt | null,
  artifactUnchanged: boolean | null = true,
  capability: ReleaseVerificationCapability = available,
  // The server affirms a match unless a test says otherwise; "unreported" omits the field.
  environmentMatches: boolean | "unreported" = true,
) =>
  deriveReleaseVerificationState({
    capability,
    attempt: value,
    artifactUnchanged,
    ...(environmentMatches === "unreported" ? {} : { environmentMatches }),
  });

const withCheck = (id: ReleaseVerificationCheckId, status: ReleaseVerificationCheck["status"]) =>
  RELEASE_VERIFICATION_REQUIRED_CHECKS.map((candidate) =>
    check(candidate, candidate === id ? status : "passed"),
  );

describe("deriveReleaseVerificationState", () => {
  it("is verified only when every required check passed and the file still matches", () => {
    expect(derive(attempt())).toEqual({ state: "verified", reasons: [] });
  });

  it("reports no attempt as none, or unavailable with the server's reason", () => {
    expect(derive(null)).toEqual({ state: "none", reasons: [] });
    expect(
      derive(null, null, { available: false, reason: "Only a macOS server can verify." }),
    ).toEqual({
      state: "unavailable",
      reasons: ["Only a macOS server can verify."],
    });
  });

  it("keeps a run with an unrun startup check short of verified", () => {
    const result = derive(attempt({ checks: withCheck("launch-smoke", "not-run") }));
    expect(result.state).toBe("needs-confirmation");
    expect(result.reasons).toContain("App startup: not run");
  });

  it.each([
    ["skipped", "skipped"],
    ["interrupted", "interrupted"],
    ["pending", "pending"],
    ["a timeout", "timed-out"],
  ] as const)(
    "needs confirmation when a check is %s, never failed or verified",
    (_name, status) => {
      expect(derive(attempt({ checks: withCheck("codesign-strict", status) })).state).toBe(
        "needs-confirmation",
      );
    },
  );

  it("needs confirmation when the run was cancelled, interrupted, or errored", () => {
    for (const phase of ["cancelled", "interrupted", "errored"] as const) {
      expect(derive(attempt({ phase })).state).toBe("needs-confirmation");
    }
    const errored = derive(attempt({ phase: "errored", error: "could not unmount" }));
    expect(errored.reasons).toContain("Verification could not finish: could not unmount");
  });

  it("is failed only for a check observed failing, and failed outranks running", () => {
    expect(derive(attempt({ checks: withCheck("image-verify", "failed") })).state).toBe("failed");
    expect(
      derive(attempt({ phase: "running", checks: withCheck("image-verify", "failed") })).state,
    ).toBe("failed");
    expect(derive(attempt({ phase: "running" })).state).toBe("running");
  });

  it("is never verified when a required check is missing, repeated, or the plan differs", () => {
    const missing = RELEASE_VERIFICATION_REQUIRED_CHECKS.filter((id) => id !== "sha256").map((id) =>
      check(id),
    );
    const duplicated = [...missing, check("codesign-strict")];
    const shortPlan = RELEASE_VERIFICATION_REQUIRED_CHECKS.filter((id) => id !== "launch-smoke");
    for (const candidate of [
      attempt({ checks: [] }),
      attempt({ checks: missing }),
      attempt({ checks: duplicated }),
      attempt({ checkSet: shortPlan }),
      attempt({ checkSet: [] }),
    ]) {
      expect(derive(candidate).state).toBe("needs-confirmation");
    }
  });

  it("is never verified under a different requirement or without a recorded file", () => {
    expect(
      derive(attempt({ requirement: { id: RELEASE_VERIFICATION_REQUIREMENT.id, version: 0 } }))
        .state,
    ).toBe("needs-confirmation");
    expect(derive(attempt({ requirement: { id: "other", version: 1 } })).state).toBe(
      "needs-confirmation",
    );
    expect(derive(attempt({ artifact: null })).state).toBe("needs-confirmation");
  });

  it("is never verified when the file changed or was not re-checked", () => {
    expect(derive(attempt(), false).state).toBe("needs-confirmation");
    expect(derive(attempt(), null).state).toBe("needs-confirmation");
  });

  it("is never verified from another environment's record, even if every check passed", () => {
    expect(derive(attempt(), true, available, true)).toEqual({ state: "verified", reasons: [] });

    // Even a payload that claims the file matches cannot override the environment.
    const claimed = derive(attempt(), true, available, false);
    expect(claimed.state).toBe("needs-confirmation");
    expect(claimed.reasons).toEqual([
      "Verification ran in a different server environment, so it does not confirm this one",
    ]);

    // Unmeasured in another environment: one honest reason, not a misleading "not re-checked".
    const unmeasured = derive(attempt(), null, available, false);
    expect(unmeasured.state).toBe("needs-confirmation");
    expect(unmeasured.reasons).toEqual(claimed.reasons);
  });

  it("treats an unreported environment as unknown, never as a match", () => {
    const unknown = derive(attempt(), true, available, "unreported");
    expect(unknown.state).toBe("needs-confirmation");
    expect(unknown.reasons).toEqual([
      "The server did not say whether this verification was made in its environment",
    ]);
    // Distinct from the other-environment reason, and the file reason still applies.
    const unmeasured = derive(attempt(), null, available, "unreported");
    expect(unmeasured.state).toBe("needs-confirmation");
    expect(unmeasured.reasons).toEqual([
      "The server did not say whether this verification was made in its environment",
      "The build file has not been re-checked",
    ]);
    expect(derive(attempt(), true, available, true).state).toBe("verified");
  });

  it("keeps an observed failure failed whichever environment recorded it", () => {
    for (const environmentMatches of [false, "unreported"] as const) {
      expect(
        derive(
          attempt({ checks: withCheck("image-verify", "failed") }),
          null,
          available,
          environmentMatches,
        ).state,
      ).toBe("failed");
    }
  });
});

describe("release verification wire shapes", () => {
  it("accepts the largest record the server writes", () => {
    const long = "x".repeat(2_000);
    const full = attempt({
      error: long.slice(0, RELEASE_VERIFICATION_ERROR_MAX_LENGTH),
      checks: RELEASE_VERIFICATION_REQUIRED_CHECKS.map((id) => ({
        ...check(id),
        detail: long.slice(0, 200),
        tail: Array.from({ length: 20 }, () => long.slice(0, 400)),
      })),
    });
    expect(Schema.is(ReleaseVerificationAttempt)(full)).toBe(true);
    expect(Schema.is(ReleaseVerificationAttempt)(attempt({ error: long }))).toBe(false);
  });

  it("carries the stored sequence and environment flag only when the server has them", () => {
    const decode = Schema.decodeUnknownExit(ReleaseVerificationGetResult);
    const base = { capability: available, attempt: attempt(), artifactUnchanged: true };

    // An older server omits both fields; the result still decodes.
    expect(Exit.isSuccess(decode(base))).toBe(true);
    expect(Exit.isSuccess(decode({ ...base, sequence: 12, environmentMatches: true }))).toBe(true);
    expect(Exit.isSuccess(decode({ ...base, sequence: 0 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...base, sequence: -1 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...base, sequence: 1.5 }))).toBe(true);
    expect(Exit.isFailure(decode({ ...base, environmentMatches: "yes" }))).toBe(true);

    const decoded = Schema.decodeUnknownSync(ReleaseVerificationGetResult)({
      ...base,
      sequence: 12,
    });
    expect(decoded.sequence).toBe(12);
    expect(decoded.attempt).toEqual(base.attempt);
  });

  it("carries a thread id and nothing else from the client", () => {
    const decoded = Schema.decodeUnknownSync(ReleaseVerificationRunInput)({
      threadId: "thread-1",
      path: "/etc/passwd",
      result: { state: "verified" },
    });
    expect(decoded).toEqual({ threadId: "thread-1" });
    expect(
      Schema.decodeUnknownSync(ReleaseVerificationCancelInput)({ threadId: "thread-1" }),
    ).toEqual({
      threadId: "thread-1",
    });
    expect(
      Exit.isFailure(Schema.decodeUnknownExit(ReleaseVerificationRunInput)({ path: "/x" })),
    ).toBe(true);
  });

  it("cannot be written through the client command union", () => {
    const decoded = Schema.decodeUnknownExit(ClientOrchestrationCommand)({
      type: "thread.activity.append",
      commandId: "command-1",
      threadId: "thread-1",
      activity: {
        id: releaseVerificationActivityId(threadId),
        tone: "info",
        kind: "release-verification",
        summary: "forged",
        payload: attempt(),
        turnId: null,
        createdAt: at,
      },
      createdAt: at,
    });
    expect(Exit.isFailure(decoded)).toBe(true);
  });
});
