import { useMemo } from "react";
import {
  ReleaseVerificationAttempt,
  type ReleaseVerificationGetResult,
  type ReleaseVerificationAttempt as ReleaseVerificationAttemptType,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { createReleaseVerificationEnvironmentAtoms } from "@t3tools/client-runtime/state/release-verification";
import { useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useEnvironmentThread } from "./threads";

export const releaseVerificationEnvironment =
  createReleaseVerificationEnvironmentAtoms(connectionAtomRuntime);
const decodeReleaseVerificationAttempt = Schema.decodeUnknownOption(ReleaseVerificationAttempt);

export interface LiveReleaseVerificationAttempt {
  readonly attempt: ReleaseVerificationAttemptType;
  readonly sequence: number | null;
}

/** Old hosts have no RPC. Transport and authorization failures remain visible. */
export function isReleaseVerificationMethodMissing(error: unknown): boolean {
  return (
    error === "Unknown request tag: releaseVerification.get" ||
    (error instanceof Error && error.message === "Unknown request tag: releaseVerification.get")
  );
}

export function newestReleaseVerificationResult(
  fetched: ReleaseVerificationGetResult,
  live: LiveReleaseVerificationAttempt | null,
): ReleaseVerificationGetResult {
  if (live === null) return fetched;
  const liveAttempt = live.attempt;
  const current = fetched.attempt;
  if (current === null)
    return {
      ...fetched,
      attempt: liveAttempt,
      artifactUnchanged: null,
      environmentMatches: undefined,
    };
  if (liveAttempt.attemptId === current.attemptId) {
    return liveAttempt.revision > current.revision
      ? { ...fetched, attempt: liveAttempt, artifactUnchanged: null, environmentMatches: undefined }
      : fetched;
  }
  // Server event sequence is the only cross-attempt order. Unknown order
  // stays unverified until a newer server get arrives.
  if (
    fetched.sequence !== undefined &&
    live.sequence !== null &&
    fetched.sequence >= live.sequence
  ) {
    return fetched;
  }
  return {
    ...fetched,
    attempt: liveAttempt,
    artifactUnchanged: null,
    environmentMatches: undefined,
  };
}

export function useReleaseVerification(environmentId: EnvironmentId, threadId: ThreadId) {
  const atom = releaseVerificationEnvironment.get({ environmentId, input: { threadId } });
  const query = useEnvironmentQuery(atom);
  // Effect RPC emits a string defect for an unknown request tag. The generic
  // query formatter intentionally turns string defects into a generic error.
  const rawResult = useAtomValue(atom);
  const unsupported =
    rawResult._tag === "Failure" &&
    isReleaseVerificationMethodMissing(Cause.squash(rawResult.cause));
  const thread = useEnvironmentThread(environmentId, threadId);
  const live = useMemo(() => {
    const activities = Option.getOrNull(thread.data)?.activities ?? [];
    const activity = activities.find(
      (entry) =>
        entry.kind === "release-verification" && entry.id === `release-verification:${threadId}`,
    );
    if (!activity) return null;
    const attempt = Option.getOrNull(decodeReleaseVerificationAttempt(activity.payload));
    return attempt === null ? null : { attempt, sequence: activity.sequence ?? null };
  }, [thread.data, threadId]);
  const result = query.data === null ? null : newestReleaseVerificationResult(query.data, live);
  return {
    ...query,
    // Hash validity comes only from a completed server get for this exact revision.
    result:
      result === null || query.isPending || query.error !== null
        ? result === null
          ? null
          : { ...result, artifactUnchanged: null }
        : result,
    live,
    unsupported,
  };
}
