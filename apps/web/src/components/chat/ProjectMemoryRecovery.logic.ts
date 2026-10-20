import { ProjectMemoryRejectedError, type ProjectMemoryThreadState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/unstable/reactivity";

import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

/** Everything the composer banner can say about this thread's recovery state. */
export type RecoveryView =
  | { readonly kind: "unsupported" }
  | { readonly kind: "none" }
  | { readonly kind: "checking" }
  | { readonly kind: "error" }
  | {
      readonly kind: "held";
      readonly latestChangeSeq: number;
      readonly shown: number;
      readonly updated: number;
      readonly deleted: number;
      readonly mayHaveMore: boolean;
    };

/** JSON tuple, so the same seq number in another environment/project/thread never matches. */
export function recoveryScopeKey(
  environmentId: string,
  projectId: string,
  threadId: string,
): string {
  return JSON.stringify([environmentId, projectId, threadId]);
}

/**
 * The last recorded turn-start failure for this thread. Activities arrive
 * sorted ascending (sequence, createdAt, id), so the final match is the
 * latest. Server turn sends report memory holds as this activity kind.
 */
export function latestTurnStartFailureId(
  activities: ReadonlyArray<{ readonly id: string; readonly kind: string }>,
): string | null {
  let latest: string | null = null;
  for (const activity of activities) {
    if (activity.kind === "provider.turn.start.failed") latest = activity.id;
  }
  return latest;
}

/**
 * Decides what the recovery banner shows. Server error messages are never
 * surfaced: every failure is either the typed thread-missing rejection (the
 * thread is gone — nothing to recover) or a generic error.
 */
export function recoveryView(input: {
  readonly supported: boolean;
  readonly result: AsyncResult.AsyncResult<ProjectMemoryThreadState, unknown>;
  readonly wasHeld: boolean;
}): RecoveryView {
  if (!input.supported) return { kind: "unsupported" };
  // Initial (never loaded, waiting, or idle) and any waiting window count as
  // pending; a scope that was held before keeps its checking marker through
  // the wait so the banner never drops and old rows never flash back.
  if (input.result._tag === "Initial" || input.result.waiting) {
    return input.wasHeld ? { kind: "checking" } : { kind: "none" };
  }
  if (input.result._tag === "Failure") {
    const cause = Cause.squash(input.result.cause);
    if (isThreadMissingRejection(cause)) {
      return { kind: "none" };
    }
    return { kind: "error" };
  }
  const state = Option.getOrNull(AsyncResult.value(input.result));
  if (state === null || !state.held) return { kind: "none" };
  if (state.latestChangeSeq === null) return { kind: "error" };
  let updated = 0;
  let deleted = 0;
  for (const change of state.changes) {
    if (change.reason === "updated") updated += 1;
    else deleted += 1;
  }
  return {
    kind: "held",
    latestChangeSeq: state.latestChangeSeq,
    shown: state.changes.length,
    updated,
    deleted,
    mayHaveMore: state.mayHaveMore,
  };
}

export interface CapturedAck {
  readonly scopeKey: string;
  readonly seq: number;
}

/**
 * The captured consent stays usable only while the exact scope is still
 * supported and still reports the very held change the user saw. A same seq
 * number in another environment/project/thread has a different scope key and
 * never matches.
 */
export function canConfirmAcknowledge(
  captured: CapturedAck | null,
  current: {
    readonly scopeKey: string;
    readonly supported: boolean;
    readonly view: RecoveryView;
  },
): boolean {
  return (
    captured !== null &&
    captured.scopeKey === current.scopeKey &&
    current.supported &&
    current.view.kind === "held" &&
    current.view.latestChangeSeq === captured.seq
  );
}

/**
 * Prepares the current unsent prompt for the new thread: recognized memory
 * references are dropped entirely (their content cannot ride along without a
 * server commit), every other recognized reference collapses to its display
 * label, and the result is trimmed. This claims nothing about unrecognized
 * text — ordinary sentences and malformed links pass through untouched.
 */
export function sanitizeUnsentPrompt(prompt: string): string {
  return replaceComposerContextReferences(prompt, (occurrence) =>
    occurrence.kind === "memory" ? "" : occurrence.label,
  ).trim();
}

/** Fixed-tag error sniff for RPC failures; the same small pattern the settings section uses. */
export function isTaggedError(value: unknown, tag: string): boolean {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === tag;
}

function isThreadMissingRejection(cause: unknown): boolean {
  if (Schema.is(ProjectMemoryRejectedError)(cause)) {
    return cause.reason === "thread-missing";
  }
  return (
    isTaggedError(cause, "ProjectMemoryRejectedError") &&
    typeof cause === "object" &&
    cause !== null &&
    "reason" in cause &&
    (cause as { readonly reason?: string }).reason === "thread-missing"
  );
}
