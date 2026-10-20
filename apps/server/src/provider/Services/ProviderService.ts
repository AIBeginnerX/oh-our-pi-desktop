/**
 * ProviderService - Service interface for provider sessions, turns, and checkpoints.
 *
 * Acts as the cross-provider facade used by transports (WebSocket/RPC). It
 * resolves provider adapters through `ProviderAdapterRegistry`, routes
 * session-scoped calls via `ProviderSessionDirectory`, and exposes one unified
 * provider event stream to callers.
 *
 * Uses Effect `Context.Service` for dependency injection and returns typed
 * domain errors for validation, session, codex, and checkpoint workflows.
 *
 * @module ProviderService
 */
import type {
  ProviderDriverKind,
  ProviderInterruptTurnInput,
  ProviderInstanceId,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  MessageId,
  ThreadId,
  ProviderTurnStartResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { ProviderServiceError } from "../Errors.ts";
import type { ContinuationToken } from "../../restartContinuations.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderAdmissionObservation,
  ProviderSubmissionRoutePreview,
} from "./ProviderAdapter.ts";
import type { ProviderInstanceRoutingInfo } from "./ProviderAdapterRegistry.ts";

/**
 * ProviderMemoryAdmissionVerdict — the verdict a valid memory recheck
 * re-judges synchronously at the adapter's publish point: the mutation fence
 * captured before its reads still holds (`changed`) and the committed items
 * have not reached their expiry (`expired`). Anything else fails closed.
 */
export type ProviderMemoryAdmissionVerdict = "valid" | "changed" | "expired";

/**
 * ProviderMemoryHandoff - Late fencing for a send that carries a committed
 * memory dispatch. `check` re-observes the memory admission state at handoff;
 * after it passes, the directory binding, registry adapter, and session
 * identity are bound to the send and re-verified synchronously inside the
 * adapter's publish step.
 */
export interface ProviderMemoryHandoff {
  /** Instance the committed attempt was admitted for. */
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * Memory recheck run first at handoff: `false` is a held attempt; a
   * function means valid at its store read and is re-evaluated synchronously
   * at adapter admission. Legacy `true` is refused (fail-closed). Defects and
   * failures are refused; interrupts propagate.
   */
  readonly check: Effect.Effect<boolean | (() => ProviderMemoryAdmissionVerdict)>;
}

/**
 * ProviderSkillTrialRoute — the routed identity a skill-trial claim is made
 * for, frozen at final routing: the resolved provider instance and the driver
 * kind of the actual routed adapter object, never inferred from the request.
 */
export interface ProviderSkillTrialRoute {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
}

/**
 * ProviderSkillTrialHandoff — late fencing for a send carrying a skill-trial
 * delivery claim. `providerInstanceId` is the caller-pinned intended
 * instance: every routing resolution must land on it or the send is refused
 * before registry work, recovery, or the claim. `enter` performs the
 * asynchronous claim for the frozen route after final routing and is invoked
 * at most once per send: `true` means the claim committed and the send may
 * proceed to adapter entry; `false` is any held, lost, or already-claimed
 * outcome — the send is refused without adapter entry and the durable
 * attempt stays `unknown`. Its error channel is `unknown` to match the
 * delivery claim API: interrupts propagate, every other failure or defect is
 * refused without the foreign cause. After a committed claim the service
 * re-observes the frozen route — binding, routed instance, and registry
 * adapter object — and re-verifies the directory fence and registry
 * ownership synchronously inside the adapter's publish step.
 */
export interface ProviderSkillTrialHandoff {
  /** Instance the committed claim intends to deliver through. */
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * The asynchronous claim for the frozen route. When `verifyUse` is
   * present the service also recomputes the actual send's submission route
   * preview on the pinned session first — independent of whatever claimed —
   * and hands it to `enter`; an adapter that cannot project one leaves the
   * field absent.
   */
  readonly enter: (
    routed: ProviderSkillTrialRoute & {
      readonly routePreview?: ProviderSubmissionRoutePreview;
    },
  ) => Effect.Effect<boolean, unknown>;
  /**
   * Optional claim-owned observer invoked synchronously inside the adapter's
   * publish-step admission, immediately before the send's admission verdict
   * admits — and only on a verdict that passes. It receives the adapter's
   * actual observation with the guarded routed instance and driver overlaid,
   * so observed data can never replace authoritative routing — or, when the
   * adapter's observation cannot even be constructed, an impossible session
   * identity under the same route so a prior capture is dropped rather than
   * settled stale. The callback must stay synchronous; an exception it
   * raises cannot manufacture capture and never alters ordinary delivery.
   */
  readonly observeSubmission?: (
    observed: ProviderAdmissionObservation & ProviderSkillTrialRoute,
  ) => void;
  /**
   * Optional claim-owned use veto — the final synchronous verdict, invoked
   * inside the adapter's publish-step admission after the write-fence and
   * registry-ownership checks and before the observer and queue. It
   * receives the same authoritative routed observation as the observer.
   * `false` or a throw refuses the publish under the public
   * `claim-refused` reason — the claim owns the verdict that declined the
   * use: nothing is queued, no turn state or events are written, and the
   * observer is never reached. When the adapter's observation cannot be
   * constructed or carries no submission candidate, the service fails
   * closed without calling it. Sends whose handoff omits it are unchanged.
   */
  readonly verifyUse?: (
    observed: ProviderAdmissionObservation & ProviderSkillTrialRoute,
  ) => boolean;
}

/**
 * ProviderSendTurnOptions - Optional per-call metadata for `sendTurn`.
 *
 * `continuation` is a restart-continuation fencing token issued by
 * `RestartContinuations`. When present, the call checks token liveness plus
 * exact thread and routed-instance identity at every admission and binding
 * write, and fails with `ProviderContinuationRevokedError` when the token has
 * been revoked (or the route diverged). Token-free calls keep the unchanged
 * path.
 *
 * `memoryHandoff` re-observes the memory admission, the routing binding, and
 * the registry adapter immediately before adapter entry, binds recovery
 * writes to the row observed at routing, and conjoins the memory verdict,
 * directory write fence, registry ownership, session generation, and native
 * session id inside the adapter's publish-step admission. Any drift or
 * failure is refused with `ProviderMemoryHandoffRefusedError`; interrupts
 * propagate.
 *
 * `skillTrialHandoff` claims the skill-trial delivery for the frozen routed
 * instance and driver after final routing, then re-observes the binding and
 * registry adapter object before adapter entry and re-verifies the directory
 * write fence and registry ownership inside the adapter's publish-step
 * admission. A declined claim, a route drift after the claim, or combining it
 * with `memoryHandoff` is refused with `ProviderSkillTrialHandoffRefusedError`
 * before any adapter entry; interrupts propagate.
 */
export interface ProviderSendTurnOptions {
  readonly continuation?: ContinuationToken;
  readonly memoryHandoff?: ProviderMemoryHandoff;
  readonly skillTrialHandoff?: ProviderSkillTrialHandoff;
}

/**
 * ProviderServiceShape - Service API for provider session and turn orchestration.
 */
export interface ProviderServiceShape {
  /**
   * Start a provider session.
   */
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;

  /**
   * Send a provider turn.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
    options?: ProviderSendTurnOptions,
  ) => Effect.Effect<ProviderTurnStartResult, ProviderServiceError>;

  /**
   * Read-only preview of the route the session currently pinned for this
   * thread would publish this input under: the resolved instance and driver
   * plus, when the adapter can project one, the submission route preview.
   * Never recovers or creates a session and never invokes provider setters.
   * `undefined` when the thread has no pinned live session to preview on.
   */
  readonly previewSubmissionRoute: (input: ProviderSendTurnInput) => Effect.Effect<
    | (ProviderSkillTrialRoute & {
        readonly routePreview?: ProviderSubmissionRoutePreview;
      })
    | undefined,
    ProviderServiceError
  >;

  readonly compactThread: (
    threadId: ThreadId,
    modelSelection?: ProviderSendTurnInput["modelSelection"],
    requestId?: MessageId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Interrupt a running provider turn.
   */
  readonly interruptTurn: (
    input: ProviderInterruptTurnInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider approval request.
   */
  readonly respondToRequest: (
    input: ProviderRespondToRequestInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Respond to a provider structured user-input request.
   */
  readonly respondToUserInput: (
    input: ProviderRespondToUserInputInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Stop a provider session.
   */
  readonly stopSession: (
    input: ProviderStopSessionInput,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * List active provider sessions.
   *
   * Aggregates runtime session lists from all registered adapters.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Read capabilities for the adapter bound to a configured provider instance.
   */
  readonly getCapabilities: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderAdapterCapabilities, ProviderServiceError>;

  readonly getInstanceInfo: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<ProviderInstanceRoutingInfo, ProviderServiceError>;

  /**
   * Reject unsupported rewind before files change, without resuming the session.
   */
  readonly assertConversationRollbackSupported: (
    threadId: ThreadId,
  ) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Roll back provider conversation state by a number of turns.
   */
  readonly rollbackConversation: (input: {
    readonly threadId: ThreadId;
    readonly numTurns: number;
  }) => Effect.Effect<void, ProviderServiceError>;

  /**
   * Upload a thread and return the provider's shareable feedback identifier.
   */
  readonly uploadFeedback: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, ProviderServiceError>;

  /**
   * Canonical provider runtime event stream.
   *
   * Fan-out is owned by ProviderService (not by a standalone event-bus service).
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}

/**
 * ProviderService - Service tag for provider orchestration.
 */
export class ProviderService extends Context.Service<ProviderService, ProviderServiceShape>()(
  "t3/provider/Services/ProviderService",
) {}
