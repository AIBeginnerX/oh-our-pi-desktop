/**
 * ProjectMemorySendGate — the single admission point between a turn start and
 * the durable send ledger. Its reference default denies all drivers; a server
 * composition may inject a boot-time allowlist. Persisted holds and fail-closed
 * reads remain authoritative in either case.
 *
 * Error policy (every method's error channel is `never`):
 * - Ledger typed errors and defects become `store-failed` holds. No cause is
 *   retained and nothing is logged at the boundary.
 * - Interruptions always propagate.
 */
import type { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  type CommitProjectMemoryDispatchInput,
  type ProjectMemorySendCommittedMemory,
  type ProjectMemorySendHoldReason,
  type ProjectMemorySendSettleState,
  type RevalidateProjectMemoryDispatchInput,
  ProjectMemorySendLedger,
  layer as sendLedgerLayer,
} from "../persistence/ProjectMemorySendLedger.ts";

// Driver allowlist injected per build. Production default is the empty set;
// there is no settings or environment switch. Tests inject the real set
// through this reference so commit paths exercise the real gate.
export const ProjectMemorySendPolicy = Context.Reference<{
  readonly driverKinds: ReadonlySet<ProviderDriverKind>;
}>("t3/memory/ProjectMemorySendPolicy", {
  defaultValue: () => ({ driverKinds: new Set() }),
});

export type MemorySendHoldReason =
  | "affected"
  | "not-supported"
  | "unavailable"
  | "version-changed"
  | "expired"
  | "too-large"
  | "already-committed"
  | "store-failed";

// Fixed user-facing hold details. No ids, titles, versions, or causes.
export const MEMORY_SEND_HOLD_DETAIL: { readonly [R in MemorySendHoldReason]: string } = {
  affected: "Project memory used by this thread changed. Review the changes before sending.",
  "not-supported": "The selected provider does not support sending project memory.",
  unavailable: "The selected project memory is unavailable.",
  "version-changed": "The selected project memory version changed.",
  expired: "The selected project memory expired.",
  "too-large": "The message with its selected project memory is too large to send.",
  "already-committed": "A project memory send was already committed for this message.",
  "store-failed": "The project memory store failed.",
};

export const MEMORY_SEND_PROVIDER_FAILURE_DETAIL =
  "Provider turn start failed. The selected project memory may have been sent.";

const toHoldReason = (reason: ProjectMemorySendHoldReason): MemorySendHoldReason =>
  reason === "context-mismatch" || reason === "empty" ? "unavailable" : reason;

// Same boundary policy as ProjectSkillSendGate's `interruptOnly`: a cause
// carrying any interrupt reason rethrows with the interrupt reasons only —
// interruption is never turned into a hold and never drags Fail/Die legs
// along.
const interruptOnly = <E>(cause: Cause.Cause<E>) =>
  Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));

/** What a valid revalidation reads as at admission time. "changed" covers a
    broken mutation fence (any memory mutation, in flight or completed,
    since the fence was captured); "expired" covers a reached or unreadable
    expiry. Both fail closed. */
export type MemoryAdmissionVerdict = "valid" | "changed" | "expired";

export class ProjectMemorySendGate extends Context.Service<
  ProjectMemorySendGate,
  {
    readonly threadHold: (
      threadId: ThreadId,
    ) => Effect.Effect<Option.Option<"affected" | "store-failed">>;
    readonly driverAllowed: (driverKind: ProviderDriverKind) => boolean;
    readonly admit: (input: CommitProjectMemoryDispatchInput) => Effect.Effect<
      | {
          readonly _tag: "Committed";
          readonly attemptSeq: number;
          readonly memories: ReadonlyArray<ProjectMemorySendCommittedMemory>;
        }
      | { readonly _tag: "Held"; readonly reason: MemorySendHoldReason }
    >;
    readonly settle: (
      attemptSeq: number,
      outcome: ProjectMemorySendSettleState,
    ) => Effect.Effect<void>;
    // Admission-time revalidation: the ledger mutation fence is captured
    // synchronously before the hold read, so a mutation committed between
    // reads still breaks the returned stillValid. stillValid is the sync
    // predicate called at the admission point; it re-judges that same fence
    // and expiry against this effect's clock.
    readonly revalidateForAdmission: (input: RevalidateProjectMemoryDispatchInput) => Effect.Effect<
      | { readonly _tag: "Held"; readonly reason: MemorySendHoldReason }
      | {
          readonly _tag: "Valid";
          readonly stillValid: () => MemoryAdmissionVerdict;
        }
    >;
    // Derived compatibility until every caller moves to
    // revalidateForAdmission — folds the result to an optional hold.
    readonly revalidate: (
      input: RevalidateProjectMemoryDispatchInput,
    ) => Effect.Effect<Option.Option<MemorySendHoldReason>>;
  }
>()("t3/memory/ProjectMemorySendGate") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const ledger = yield* ProjectMemorySendLedger;
  // Read once: the allowlist is a build-time decision, not a runtime toggle.
  const policy = yield* ProjectMemorySendPolicy;

  const threadHold = (
    threadId: ThreadId,
  ): Effect.Effect<Option.Option<"affected" | "store-failed">> =>
    ledger.affectedState({ threadId, limit: 1 }).pipe(
      Effect.map((state) => (state.held ? Option.some("affected" as const) : Option.none())),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? interruptOnly(cause)
          : Effect.succeed(Option.some("store-failed" as const)),
      ),
    );

  const driverAllowed = (driverKind: ProviderDriverKind) => policy.driverKinds.has(driverKind);

  const admit = (
    input: CommitProjectMemoryDispatchInput,
  ): Effect.Effect<
    | {
        readonly _tag: "Committed";
        readonly attemptSeq: number;
        readonly memories: ReadonlyArray<ProjectMemorySendCommittedMemory>;
      }
    | { readonly _tag: "Held"; readonly reason: MemorySendHoldReason }
  > =>
    ledger.commitDispatch(input).pipe(
      Effect.map((result) =>
        result.status === "committed"
          ? {
              _tag: "Committed" as const,
              attemptSeq: result.attemptSeq,
              memories: result.memories,
            }
          : { _tag: "Held" as const, reason: toHoldReason(result.reason) },
      ),
      Effect.catch(() =>
        Effect.succeed({ _tag: "Held" as const, reason: "store-failed" as const }),
      ),
      Effect.catchDefect(() =>
        Effect.succeed({ _tag: "Held" as const, reason: "store-failed" as const }),
      ),
    );

  const settle = (attemptSeq: number, outcome: ProjectMemorySendSettleState): Effect.Effect<void> =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        yield* ledger.settle({ attemptSeq, outcome, now: yield* DateTime.now }).pipe(Effect.asVoid);
      }).pipe(
        Effect.catch(() => Effect.logWarning("project memory send settle failed", { attemptSeq })),
        Effect.catchDefect(() =>
          Effect.logWarning("project memory send settle failed", { attemptSeq }),
        ),
      ),
    );

  const revalidateForAdmission = (
    input: RevalidateProjectMemoryDispatchInput,
  ): Effect.Effect<
    | { readonly _tag: "Held"; readonly reason: MemorySendHoldReason }
    | { readonly _tag: "Valid"; readonly stillValid: () => MemoryAdmissionVerdict }
  > =>
    Effect.gen(function* () {
      // The fence is captured synchronously before the first store read: a
      // mutation that is in flight or commits after this point — including
      // one a later read can never see, like a memory outside this attempt —
      // breaks stillValid below.
      const fence = ledger.captureMutationFence();
      // This effect's clock — the fiber-local Clock service, a TestClock in
      // tests — is read inside stillValid, at the admission point.
      const clock = yield* Clock.Clock;
      // An existing thread hold wins before the attempt is re-read.
      const existing = yield* threadHold(input.threadId);
      if (Option.isSome(existing)) {
        return { _tag: "Held" as const, reason: existing.value };
      }
      const result = yield* ledger.revalidateDispatch(input);
      if (result.status === "held") {
        return { _tag: "Held" as const, reason: toHoldReason(result.reason) };
      }
      const minValidUntilMillis = result.minValidUntilMillis;
      const stillValid = (): MemoryAdmissionVerdict => {
        try {
          if (!ledger.mutationFenceHolds(fence)) return "changed";
          // The clock is sampled on every call: a reading that is not
          // finite — or a reader that throws — fails closed even when the
          // attempt carries no expiry.
          const now = clock.currentTimeMillisUnsafe();
          if (!Number.isFinite(now)) return "changed";
          if (minValidUntilMillis !== null) {
            if (!Number.isFinite(minValidUntilMillis)) return "changed";
            // Expiry equality expires.
            if (now >= minValidUntilMillis) return "expired";
          }
          return "valid";
        } catch {
          return "changed";
        }
      };
      return { _tag: "Valid" as const, stillValid };
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? interruptOnly(cause)
          : Effect.succeed({ _tag: "Held" as const, reason: "store-failed" as const }),
      ),
    );

  const revalidate = (
    input: RevalidateProjectMemoryDispatchInput,
  ): Effect.Effect<Option.Option<MemorySendHoldReason>> =>
    Effect.map(revalidateForAdmission(input), (result) =>
      result._tag === "Held" ? Option.some(result.reason) : Option.none(),
    );

  return {
    threadHold,
    driverAllowed,
    admit,
    settle,
    revalidateForAdmission,
    revalidate,
  } satisfies ProjectMemorySendGate["Service"];
});

// One ledger lifetime per gate build; the shared SqlClient comes from the
// ambient layer graph.
export const layer = Layer.effect(ProjectMemorySendGate, make).pipe(Layer.provide(sendLedgerLayer));

// For harnesses that have nothing to do with project memory. Never a
// substitute for the real gate on production or real integration paths.
export const layerUnavailable = Layer.succeed(ProjectMemorySendGate)({
  threadHold: () => Effect.succeed(Option.none()),
  driverAllowed: () => false,
  admit: () => Effect.succeed({ _tag: "Held" as const, reason: "not-supported" as const }),
  settle: () => Effect.void,
  revalidateForAdmission: () =>
    Effect.succeed({ _tag: "Held" as const, reason: "not-supported" as const }),
  revalidate: () => Effect.succeed(Option.some("not-supported" as const)),
});
