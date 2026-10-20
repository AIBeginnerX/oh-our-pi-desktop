import {
  WS_METHODS,
  type OwnedResultUsageOutcome,
  type OwnedResultUsageV1,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import type { SelectedChecksRecordIdentity } from "./selectedChecks";
import { useAtomCommand } from "./use-atom-command";

/**
 * One-shot usage read; every call is its own request, never a shared cached
 * value. A reconnected or revisited thread can never revive an old result.
 */
export const resultUsageGet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:result-usage:get",
  tag: WS_METHODS.usageGetThreadResults,
});

/** Old hosts have no RPC. Transport and authorization failures remain visible. */
export function isResultUsageMethodMissing(error: unknown): boolean {
  return (
    error === `Unknown request tag: ${WS_METHODS.usageGetThreadResults}` ||
    (error instanceof Error &&
      error.message === `Unknown request tag: ${WS_METHODS.usageGetThreadResults}`)
  );
}

/**
 * Bounded display states for the disclosure. Every non-`row` state is fixed
 * copy: no cached numbers, no raw errors, and never zero usage as a stand-in
 * for an unavailable read.
 */
export type ResultUsageDisclosureState =
  | { readonly phase: "hidden" }
  | { readonly phase: "loading" }
  | { readonly phase: "unsupported" }
  | { readonly phase: "read-failed" }
  | { readonly phase: "row-missing" }
  | { readonly phase: "missing-create" }
  | { readonly phase: "too-large" }
  | {
      readonly phase: "row";
      readonly readThroughSequence: number;
      readonly row: OwnedResultUsageV1;
    };

/**
 * Whether two identities describe the same bound read: environment, registry
 * entry, prepared connection, supervisor generation, local incarnation,
 * confirmed permission, and the exact attempt/revision/displayed-receipt
 * sequence the numbers were read for.
 */
function sameResultUsageIdentity(
  a: SelectedChecksRecordIdentity,
  b: SelectedChecksRecordIdentity,
): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.attemptId === b.attemptId &&
    a.revision === b.revision &&
    a.receiptSequence === b.receiptSequence &&
    a.incarnation === b.incarnation &&
    a.permission === b.permission &&
    a.permissionStatus === b.permissionStatus &&
    a.stamp?.entryId === b.stamp?.entryId &&
    a.stamp?.generation === b.stamp?.generation &&
    a.stamp?.preparedId === b.stamp?.preparedId
  );
}

/**
 * Judges one successful outcome against the bound identity. The row counts
 * only when the outcome names this thread, the captured head covers the
 * displayed receipt row, and the returned row is the exact displayed
 * representative — attempt, revision, and `finalSequence` equal to the
 * displayed receipt sequence. A newer identical-revision representative is
 * not the displayed event; it is refresh-needed instead. Legitimate non-row
 * outcomes (missing-create, too-large) keep their own fixed states. The
 * identity's incarnation is the local observation counter and is never
 * compared to the outcome's server-side `incarnationSequence`.
 */
function judgeOutcome(
  outcome: OwnedResultUsageOutcome,
  identity: SelectedChecksRecordIdentity,
): ResultUsageDisclosureState {
  if (outcome.threadId !== identity.threadId) return { phase: "row-missing" };
  if (outcome.status === "missing-create") return { phase: "missing-create" };
  if (outcome.status === "too-large") return { phase: "too-large" };
  if (outcome.readThroughSequence < identity.receiptSequence) return { phase: "row-missing" };
  const row = outcome.results.find(
    (candidate) =>
      candidate.attemptId === identity.attemptId &&
      candidate.revision === identity.revision &&
      candidate.finalSequence === identity.receiptSequence,
  );
  return row === undefined
    ? { phase: "row-missing" }
    : { phase: "row", readThroughSequence: outcome.readThroughSequence, row };
}

/**
 * Maps one settled command result for the bound identity. Failures classify
 * into the fixed unsupported/read-failed states; no failure fabricates zero
 * or success.
 */
function settleResult(
  result: AtomCommandResult<OwnedResultUsageOutcome, unknown>,
  identity: SelectedChecksRecordIdentity,
): ResultUsageDisclosureState {
  if (result._tag === "Success") return judgeOutcome(result.value, identity);
  return isResultUsageMethodMissing(squashAtomCommandFailure(result))
    ? { phase: "unsupported" }
    : { phase: "read-failed" };
}

/**
 * The read state for the open panel: armed (waiting to issue on the next
 * eligible identity), stale (invalidated — only an explicit refresh/reopen
 * rearms), or bound to one request token with its captured authority and
 * settled state (`null` while that request is pending).
 */
type UsageRead =
  | { readonly kind: "armed" }
  | { readonly kind: "stale" }
  | {
      readonly kind: "bound";
      readonly token: number;
      readonly identity: SelectedChecksRecordIdentity;
      readonly settled: ResultUsageDisclosureState | null;
    };

const ARMED: UsageRead = { kind: "armed" };
const STALE: UsageRead = { kind: "stale" };

/**
 * One-shot usage read for the currently displayed passed selected-check
 * record. Each issued request owns its completion: the token and the fresh
 * guarded identity captured at invocation close over that request's
 * completion promise, settlement rechecks a fresh guarded identity before
 * publishing, and rendering compares the bound identity synchronously — an
 * obsolete response can finish but can never publish. Close, refresh, and
 * authority drift advance the token and invalidate; reopen and refresh own
 * the new request. No polling, no shared cache, no provider work.
 */
export function useResultUsageDisclosure(input: {
  readonly identity: SelectedChecksRecordIdentity | null;
  readonly readRecordIdentity: () => SelectedChecksRecordIdentity | null;
  readonly open: boolean;
}): {
  readonly state: ResultUsageDisclosureState;
  readonly refresh: () => void;
} {
  const { identity, open, readRecordIdentity } = input;
  const getUsage = useAtomCommand(resultUsageGet, {
    reportFailure: false,
    reportDefect: false,
  });
  const tokenRef = useRef(0);
  const armedRef = useRef(true);
  const activeRef = useRef(false);
  const [read, setRead] = useState<UsageRead>(ARMED);

  const arm = useCallback(() => {
    tokenRef.current += 1;
    armedRef.current = true;
    setRead(ARMED);
  }, []);

  // Active before the issuing effect below, so a completion can never arrive
  // while the flag is still false; cleanup marks the hook inactive.
  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const eligible =
    open &&
    identity !== null &&
    identity.stamp !== null &&
    identity.permissionStatus === "confirmed";

  // Issuance and invalidation transitions, judged on every commit with the
  // latest closures. Drift invalidates without re-querying; the explicit
  // refresh/reopen path rearms.
  useLayoutEffect(() => {
    if (!open) {
      if (read.kind !== "armed") arm();
      return;
    }
    if (read.kind === "armed") {
      if (!eligible || identity === null) return;
      if (!armedRef.current) return;
      // A read may only issue for a committed eligible identity that a fresh
      // guarded read confirms. During a reconfirm the controller's own
      // re-read can make this render eligible while the fresh read is still
      // null: stay armed for the next committed identity instead of marking
      // an unissued request stale. Nothing is consumed on this path.
      const fresh = readRecordIdentity();
      if (fresh === null || !sameResultUsageIdentity(fresh, identity)) {
        return;
      }
      // Consume the arm synchronously so a StrictMode setup replay cannot
      // issue the same arm twice.
      armedRef.current = false;
      const token = ++tokenRef.current;
      setRead({ kind: "bound", token, identity: fresh, settled: null });
      void getUsage({
        environmentId: fresh.environmentId,
        input: { threadId: fresh.threadId },
      }).then((result) => {
        if (!activeRef.current || tokenRef.current !== token) return;
        const freshNow = readRecordIdentity();
        if (freshNow === null || !sameResultUsageIdentity(freshNow, fresh)) {
          tokenRef.current += 1;
          setRead(STALE);
          return;
        }
        setRead({ kind: "bound", token, identity: fresh, settled: settleResult(result, fresh) });
      });
      return;
    }
    if (
      read.kind === "bound" &&
      (identity === null || !sameResultUsageIdentity(read.identity, identity))
    ) {
      tokenRef.current += 1;
      setRead(STALE);
    }
  });

  let state: ResultUsageDisclosureState;
  if (!eligible || identity === null) {
    state = { phase: "hidden" };
  } else if (read.kind === "armed") {
    state = { phase: "loading" };
  } else if (read.kind === "bound" && sameResultUsageIdentity(read.identity, identity)) {
    // Pending wins before any numeric output; the settled state carries the
    // whole judged outcome, including the fixed non-row phases.
    state = read.settled ?? { phase: "loading" };
  } else {
    state = { phase: "row-missing" };
  }

  const refresh = useCallback(() => {
    arm();
  }, [arm]);

  return { state, refresh };
}
