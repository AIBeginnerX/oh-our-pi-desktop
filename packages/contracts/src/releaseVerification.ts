import * as Schema from "effect/Schema";

import { EnvironmentId, IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/**
 * Server-run verification of a thread's macOS release build. Only the server
 * writes the record: it picks the DMG itself, runs every check, and stores the
 * result as a thread activity under one fixed id, so a client can read the
 * outcome but never submit one. Every change is its own durable event; the
 * projection keeps the newest, which makes the current attempt the latest write.
 *
 * Verified means the checks below passed on the server host and the file on
 * disk still hashes to what was checked. It says nothing about the UI,
 * features, or notarization.
 */
export const RELEASE_VERIFICATION_ACTIVITY_KIND = "release-verification";
export const releaseVerificationActivityId = (threadId: ThreadId) =>
  `release-verification:${threadId}`;

export const RELEASE_VERIFICATION_REQUIREMENT = {
  id: "oop.macos.dmg.integrity-startup",
  version: 1,
} as const;

/** Checks run in this order; a record that lacks any of them is never verified. */
export const RELEASE_VERIFICATION_REQUIRED_CHECKS = [
  "sha256",
  "image-verify",
  "mount-readonly",
  "app-bundle",
  "codesign-strict",
  "launch-smoke",
] as const;

/** Producers clamp free text to these before writing so encoding never fails. */
export const RELEASE_VERIFICATION_DETAIL_MAX_LENGTH = 200;
export const RELEASE_VERIFICATION_TAIL_LINE_MAX_LENGTH = 400;
export const RELEASE_VERIFICATION_TAIL_MAX_LINES = 20;
export const RELEASE_VERIFICATION_ERROR_MAX_LENGTH = 1000;

export const ReleaseVerificationCheckId = Schema.Literals(RELEASE_VERIFICATION_REQUIRED_CHECKS);
export type ReleaseVerificationCheckId = typeof ReleaseVerificationCheckId.Type;

export const ReleaseVerificationCheckStatus = Schema.Literals([
  "pending",
  "running",
  "passed",
  "failed",
  "timed-out",
  "interrupted",
  "skipped",
  "not-run",
]);
export type ReleaseVerificationCheckStatus = typeof ReleaseVerificationCheckStatus.Type;

export const ReleaseVerificationCheck = Schema.Struct({
  id: ReleaseVerificationCheckId,
  status: ReleaseVerificationCheckStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  exitCode: Schema.NullOr(Schema.Int),
  /** Short trailing text for the row: an exit code, a reason, a hash prefix. */
  detail: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(RELEASE_VERIFICATION_DETAIL_MAX_LENGTH)),
  ),
  /** Last output lines of the check's command, newest last. */
  tail: Schema.Array(
    Schema.String.check(Schema.isMaxLength(RELEASE_VERIFICATION_TAIL_LINE_MAX_LENGTH)),
  ).check(Schema.isMaxLength(RELEASE_VERIFICATION_TAIL_MAX_LINES)),
});
export type ReleaseVerificationCheck = typeof ReleaseVerificationCheck.Type;

export const ReleaseVerificationPhase = Schema.Literals([
  "running",
  "completed",
  "cancelled",
  "interrupted",
  "errored",
]);
export type ReleaseVerificationPhase = typeof ReleaseVerificationPhase.Type;

export const ReleaseVerificationAttempt = Schema.Struct({
  threadId: ThreadId,
  attemptId: Schema.String.check(Schema.isNonEmpty()),
  /** Goes up with every write of this attempt, so a reader keeps the newest copy. */
  revision: NonNegativeInt,
  requirement: Schema.Struct({ id: Schema.String, version: Schema.Int }),
  /** The required checks copied at start, so a later change to the set is visible. */
  checkSet: Schema.Array(ReleaseVerificationCheckId),
  environment: Schema.Struct({
    environmentId: EnvironmentId,
    platform: Schema.String,
    arch: Schema.String,
    osRelease: Schema.String,
    serverVersion: Schema.String,
  }),
  /** Null until the server has hashed the file it is checking. */
  artifact: Schema.NullOr(
    Schema.Struct({
      workspaceRoot: Schema.String,
      relativePath: Schema.String,
      fileName: Schema.String,
      appVersion: Schema.String,
      sha256: Schema.String,
      size: NonNegativeInt,
      ino: Schema.Number,
      mtimeMs: Schema.Number,
    }),
  ),
  /** The server's private working folder; present while it may still exist. */
  runDir: Schema.NullOr(Schema.String),
  phase: ReleaseVerificationPhase,
  checks: Schema.Array(ReleaseVerificationCheck),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  error: Schema.NullOr(
    Schema.String.check(Schema.isMaxLength(RELEASE_VERIFICATION_ERROR_MAX_LENGTH)),
  ),
});
export type ReleaseVerificationAttempt = typeof ReleaseVerificationAttempt.Type;

export const ReleaseVerificationState = Schema.Literals([
  "none",
  "unavailable",
  "failed",
  "running",
  "needs-confirmation",
  "verified",
]);
export type ReleaseVerificationState = typeof ReleaseVerificationState.Type;

/** Decided by the server host, never by the client's platform. */
export const ReleaseVerificationCapability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(Schema.String),
});
export type ReleaseVerificationCapability = typeof ReleaseVerificationCapability.Type;

export const ReleaseVerificationGetInput = Schema.Struct({ threadId: ThreadId });
export type ReleaseVerificationGetInput = typeof ReleaseVerificationGetInput.Type;

export const ReleaseVerificationGetResult = Schema.Struct({
  capability: ReleaseVerificationCapability,
  attempt: Schema.NullOr(ReleaseVerificationAttempt),
  /**
   * Whether the file on disk still hashes to the verified one, measured when
   * this was read. Null when it was not measured (not finished, or too slow).
   */
  artifactUnchanged: Schema.NullOr(Schema.Boolean),
  /**
   * The server event sequence stored with the record. It is the only order
   * between attempts: timestamps can tie or run backwards. Omitted when there
   * is no record, or the stored row carries none.
   */
  sequence: Schema.optional(NonNegativeInt),
  /**
   * Whether the record was made in this server's environment (id, platform,
   * architecture, OS release, server version). False means it is another
   * host's or version's evidence: it stays visible but never confirms this
   * one. Omitted when there is no record. Omitted with a record means unknown,
   * not a match: only `true` can verify.
   */
  environmentMatches: Schema.optional(Schema.Boolean),
});
export type ReleaseVerificationGetResult = typeof ReleaseVerificationGetResult.Type;

/** The client names a thread only; the server finds the build and runs the checks. */
export const ReleaseVerificationRunInput = Schema.Struct({ threadId: ThreadId });
export type ReleaseVerificationRunInput = typeof ReleaseVerificationRunInput.Type;

export const ReleaseVerificationRunResult = Schema.Struct({
  attemptId: Schema.String.check(Schema.isNonEmpty()),
});
export type ReleaseVerificationRunResult = typeof ReleaseVerificationRunResult.Type;

export const ReleaseVerificationCancelInput = Schema.Struct({ threadId: ThreadId });
export type ReleaseVerificationCancelInput = typeof ReleaseVerificationCancelInput.Type;

export const ReleaseVerificationCancelResult = Schema.Struct({ cancelled: Schema.Boolean });
export type ReleaseVerificationCancelResult = typeof ReleaseVerificationCancelResult.Type;

export class ReleaseVerificationUnavailableError extends Schema.TaggedError<ReleaseVerificationUnavailableError>()(
  "ReleaseVerificationUnavailableError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Release verification is unavailable: ${this.reason}`;
  }
}

/**
 * Another thread's verification is already running on this server. A duplicate
 * `run` for the same thread while it is active returns the existing attemptId
 * instead of starting a second run.
 */
export class ReleaseVerificationBusyError extends Schema.TaggedError<ReleaseVerificationBusyError>()(
  "ReleaseVerificationBusyError",
  {},
) {
  override get message(): string {
    return "Another release verification is already running on this server.";
  }
}

export class ReleaseVerificationArtifactNotFoundError extends Schema.TaggedError<ReleaseVerificationArtifactNotFoundError>()(
  "ReleaseVerificationArtifactNotFoundError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `No macOS build to verify: ${this.reason}`;
  }
}

export class ReleaseVerificationThreadNotFoundError extends Schema.TaggedError<ReleaseVerificationThreadNotFoundError>()(
  "ReleaseVerificationThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' does not exist.`;
  }
}

export function releaseVerificationCheckLabel(id: ReleaseVerificationCheckId): string {
  switch (id) {
    case "sha256":
      return "Image hash";
    case "image-verify":
      return "Disk image integrity";
    case "mount-readonly":
      return "Read-only mount";
    case "app-bundle":
      return "App bundle";
    case "codesign-strict":
      return "Code signature";
    case "launch-smoke":
      return "App startup";
  }
}

export interface ReleaseVerificationDerivedState {
  readonly state: ReleaseVerificationState;
  readonly reasons: Array<string>;
}

/** Whether `ids` holds every required check exactly once and nothing else. */
const isExactRequiredSet = (ids: ReadonlyArray<ReleaseVerificationCheckId>) =>
  ids.length === RELEASE_VERIFICATION_REQUIRED_CHECKS.length &&
  RELEASE_VERIFICATION_REQUIRED_CHECKS.every(
    (required) => ids.filter((id) => id === required).length === 1,
  );

/**
 * The one place a record becomes a state, shared by the server and every
 * client. It fails closed: `verified` needs a finished attempt for the
 * current requirement whose checks are exactly the required set, all passed,
 * with the file on disk still matching, measured by the server that made the
 * record, which the server must affirm (`environmentMatches` true: absent
 * means unknown, never a match). Anything missing, skipped, not run, timed
 * out, interrupted, cancelled, or errored (the server could not finish or
 * clean up), or made in another or an unknown server environment, needs
 * confirmation; only a check that was observed failing reads as failed.
 * Precedence: failed, running, needs-confirmation, verified.
 */
export function deriveReleaseVerificationState(
  result: ReleaseVerificationGetResult,
): ReleaseVerificationDerivedState {
  const { attempt } = result;
  if (attempt === null) {
    return result.capability.available
      ? { state: "none", reasons: [] }
      : {
          state: "unavailable",
          reasons: result.capability.reason === null ? [] : [result.capability.reason],
        };
  }

  const failed = attempt.checks.filter((check) => check.status === "failed");
  if (failed.length > 0) {
    return {
      state: "failed",
      reasons: failed.map((check) => `${releaseVerificationCheckLabel(check.id)} failed`),
    };
  }
  if (attempt.phase === "running") return { state: "running", reasons: [] };

  const reasons: Array<string> = [];
  if (attempt.phase === "cancelled") reasons.push("Verification was cancelled");
  if (attempt.phase === "interrupted") reasons.push("Verification was interrupted");
  if (attempt.phase === "errored") {
    reasons.push(
      attempt.error === null
        ? "Verification could not finish"
        : `Verification could not finish: ${attempt.error}`,
    );
  }
  if (
    attempt.requirement.id !== RELEASE_VERIFICATION_REQUIREMENT.id ||
    attempt.requirement.version !== RELEASE_VERIFICATION_REQUIREMENT.version
  ) {
    reasons.push("Verification used a different requirement than the current one");
  }
  if (!isExactRequiredSet(attempt.checkSet)) reasons.push("Verification did not plan every check");
  if (!isExactRequiredSet(attempt.checks.map((check) => check.id))) {
    reasons.push("Verification did not record every check exactly once");
  }
  for (const check of attempt.checks) {
    if (check.status !== "passed") {
      reasons.push(`${releaseVerificationCheckLabel(check.id)}: ${check.status.replace("-", " ")}`);
    }
  }
  if (attempt.artifact === null) reasons.push("No build file was recorded");
  // Only an affirmative match counts: a result that does not say is not a match.
  if (result.environmentMatches === false) {
    reasons.push(
      "Verification ran in a different server environment, so it does not confirm this one",
    );
  } else if (result.environmentMatches === undefined) {
    reasons.push("The server did not say whether this verification was made in its environment");
  }
  if (result.artifactUnchanged === false) {
    reasons.push("The build file changed or is missing since it was verified");
  } else if (result.artifactUnchanged === null && result.environmentMatches !== false) {
    reasons.push("The build file has not been re-checked");
  }

  return reasons.length === 0
    ? { state: "verified", reasons }
    : { state: "needs-confirmation", reasons };
}
