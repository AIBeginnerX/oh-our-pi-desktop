import {
  WS_METHODS,
  type EnvironmentId,
  type ThreadId,
  type ThreadUsageSummary,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useLayoutEffect, useRef, useState } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "./use-atom-command";

/**
 * One-shot chat usage footer read; every call is its own request, never a
 * polled or cached value. Fetched when a thread opens and again when its
 * latest turn or its audit settles.
 */
export const threadUsageSummaryGet = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread-usage-summary:get",
  tag: WS_METHODS.threadUsageSummary,
});

/** Old hosts have no RPC; the footer hides silently instead of erroring. */
export function isThreadUsageSummaryMethodMissing(error: unknown): boolean {
  return (
    error === `Unknown request tag: ${WS_METHODS.threadUsageSummary}` ||
    (error instanceof Error &&
      error.message === `Unknown request tag: ${WS_METHODS.threadUsageSummary}`)
  );
}

export type ThreadUsageFetchDecision =
  | { readonly kind: "fetch"; readonly key: string }
  | { readonly kind: "wait" };

/**
 * The one fetch-timing rule, pure so tests can drive it. A fetch issues when
 * the thread is first seen (open) and again whenever the latest turn's
 * settled identity or completed audit count changes; a running turn never triggers one, so streaming
 * updates cannot refetch. `key` folds in the settled flag so settling a turn
 * this client opened mid-flight still refetches.
 */
export function decideThreadUsageFetch(input: {
  readonly fetchedKey: string | null;
  readonly fetchedThread: ThreadId | null;
  readonly threadId: ThreadId | null;
  readonly latestTurnId: string | null;
  readonly latestTurnSettled: boolean;
  readonly auditRunning?: boolean;
  readonly completedAuditCount?: number;
  readonly unsupported: boolean;
}): ThreadUsageFetchDecision {
  if (input.unsupported || input.threadId === null) return { kind: "wait" };
  const settled = input.latestTurnSettled && !input.auditRunning;
  const key = JSON.stringify([
    input.threadId,
    input.latestTurnId,
    settled,
    ...(input.completedAuditCount ? [input.completedAuditCount] : []),
  ]);
  if (input.fetchedKey === key) return { kind: "wait" };
  const firstForThread = input.fetchedThread !== input.threadId;
  if (!firstForThread && !settled) return { kind: "wait" };
  return { kind: "fetch", key };
}

/**
 * The settled summary for the open thread, or null when nothing should show:
 * before the first read lands, on any failure, or on a server without the
 * method. No polling, no refetch per streaming update.
 */
export function useThreadUsageSummary(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly latestTurnId: string | null;
  readonly latestTurnSettled: boolean;
  readonly auditRunning?: boolean;
  readonly completedAuditCount?: number;
}): ThreadUsageSummary | null {
  const { environmentId, threadId, latestTurnId, latestTurnSettled } = input;
  const getSummary = useAtomCommand(threadUsageSummaryGet, {
    reportFailure: false,
    reportDefect: false,
  });
  const [summary, setSummary] = useState<ThreadUsageSummary | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const fetchedKeyRef = useRef<string | null>(null);
  const fetchedThreadRef = useRef<ThreadId | null>(null);
  const tokenRef = useRef(0);
  const activeRef = useRef(false);

  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  // Judged on every commit with the latest closures; the key is consumed
  // synchronously so a StrictMode setup replay cannot issue the same fetch
  // twice, and a late response with an outdated token can never publish.
  useLayoutEffect(() => {
    const decision = decideThreadUsageFetch({
      fetchedKey: fetchedKeyRef.current,
      fetchedThread: fetchedThreadRef.current,
      threadId,
      latestTurnId,
      latestTurnSettled,
      auditRunning: input.auditRunning ?? false,
      completedAuditCount: input.completedAuditCount ?? 0,
      unsupported,
    });
    if (decision.kind !== "fetch" || threadId === null) return;
    fetchedKeyRef.current = decision.key;
    fetchedThreadRef.current = threadId;
    const token = ++tokenRef.current;
    void getSummary({ environmentId, input: { threadId } }).then((result) => {
      if (!activeRef.current || tokenRef.current !== token) return;
      if (result._tag === "Success") {
        setSummary(result.value);
        return;
      }
      if (isThreadUsageSummaryMethodMissing(squashAtomCommandFailure(result))) {
        setUnsupported(true);
      }
      // Every other failure keeps the last summary: a muted footer never
      // shouts, and the next settled turn refetches.
    });
  });

  return unsupported ? null : summary;
}
