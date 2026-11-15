import type { ApprovalRequestId, ProviderApprovalDecision } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

export function settlePendingApprovalsAsCancelled(
  pendingApprovals: ReadonlyMap<
    ApprovalRequestId,
    { readonly decision: Deferred.Deferred<ProviderApprovalDecision> }
  >,
): Effect.Effect<void> {
  return Effect.forEach(
    Array.from(pendingApprovals.values()),
    (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
    { discard: true },
  );
}
