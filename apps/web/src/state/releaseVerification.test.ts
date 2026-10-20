import {
  EnvironmentId,
  ThreadId,
  type ReleaseVerificationAttempt,
  type ReleaseVerificationGetResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Cause from "effect/Cause";
import {
  isReleaseVerificationMethodMissing,
  newestReleaseVerificationResult,
} from "./releaseVerification";

const baseAttempt: ReleaseVerificationAttempt = {
  threadId: ThreadId.make("thread-1"),
  attemptId: "first",
  revision: 2,
  requirement: { id: "oop.macos.dmg.integrity-startup", version: 1 },
  checkSet: [],
  environment: {
    environmentId: EnvironmentId.make("server-1"),
    platform: "darwin",
    arch: "arm64",
    osRelease: "25.0",
    serverVersion: "0.0.44",
  },
  artifact: null,
  runDir: null,
  phase: "completed",
  checks: [],
  startedAt: "2026-10-02T01:00:00.000Z" as ReleaseVerificationAttempt["startedAt"],
  endedAt: "2026-10-02T01:01:00.000Z" as ReleaseVerificationAttempt["endedAt"],
  error: null,
};

const fetched: ReleaseVerificationGetResult = {
  capability: { available: true, reason: null },
  attempt: baseAttempt,
  artifactUnchanged: true,
  environmentMatches: true,
  sequence: 10,
};

describe("release verification client ordering", () => {
  it("keeps a newer live attempt over a stale get even when the clock rolled back", () => {
    const newer = {
      ...baseAttempt,
      attemptId: "second",
      revision: 0,
      phase: "running" as const,
      startedAt: "2026-10-01T23:00:00.000Z" as ReleaseVerificationAttempt["startedAt"],
      endedAt: null,
    };
    expect(
      newestReleaseVerificationResult(fetched, { attempt: newer, sequence: 11 }),
    ).toMatchObject({
      attempt: { attemptId: "second", phase: "running" },
      artifactUnchanged: null,
      environmentMatches: undefined,
    });
  });

  it("fails closed when cross-attempt sequence is absent, even with equal timestamps", () => {
    const sameTime = { ...baseAttempt, attemptId: "second" };
    expect(
      newestReleaseVerificationResult(fetched, { attempt: sameTime, sequence: null }),
    ).toMatchObject({
      attempt: { attemptId: "second" },
      artifactUnchanged: null,
    });
  });

  it("accepts a newer server get and rejects an older same-attempt revision", () => {
    const older = { ...baseAttempt, attemptId: "second", revision: 1 };
    expect(newestReleaseVerificationResult(fetched, { attempt: older, sequence: 9 })).toBe(fetched);
    expect(
      newestReleaseVerificationResult(fetched, {
        attempt: { ...baseAttempt, revision: 3 },
        sequence: 11,
      }),
    ).toMatchObject({
      attempt: { revision: 3 },
      artifactUnchanged: null,
    });
  });
});

describe("older server detection", () => {
  it("hides only an explicit missing release-verification method", () => {
    expect(isReleaseVerificationMethodMissing("Unknown request tag: releaseVerification.get")).toBe(
      true,
    );
    expect(
      isReleaseVerificationMethodMissing(new Error("Unknown request tag: releaseVerification.get")),
    ).toBe(true);
    expect(
      isReleaseVerificationMethodMissing(
        Cause.squash(Cause.die("Unknown request tag: releaseVerification.get")),
      ),
    ).toBe(true);
    expect(isReleaseVerificationMethodMissing("Unknown request tag: thread.get")).toBe(false);
    expect(isReleaseVerificationMethodMissing("releaseVerification.get network unavailable")).toBe(
      false,
    );
    expect(isReleaseVerificationMethodMissing("releaseVerification.get authorization denied")).toBe(
      false,
    );
    expect(
      isReleaseVerificationMethodMissing("releaseVerification.get unsupported host platform"),
    ).toBe(false);
  });
});
