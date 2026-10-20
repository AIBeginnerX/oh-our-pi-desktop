/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

/**
 * How ProviderService runs manual context compaction for an adapter.
 * Native adapters expose a start call and must emit a compacted thread state
 * when they finish. Slash-command adapters get the command sent as a turn.
 */
export type ProviderCompaction<TError> =
  | {
      readonly type: "native";
      readonly start: (
        threadId: ThreadId,
        modelSelection?: ProviderSendTurnInput["modelSelection"],
      ) => Effect.Effect<void, TError>;
    }
  | { readonly type: "slash-command"; readonly command: `/${string}` };

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /** Starts a resumed turn with no synthetic user prompt. Omitted means the
      adapter needs an explicit continuation instruction. */
  readonly promptlessTurnContinuation?: boolean;
  /** False when native conversation history cannot be rewound. */
  readonly supportsConversationRollback?: boolean;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

/**
 * ProviderAdmissionObservation — the session identity an adapter reports to
 * the sendTurn admission callback at its synchronous publish step.
 * `sessionGeneration` identifies the exact session context and moves on every
 * context recreation or native session id change; `nativeSessionId` is the
 * id that context currently resumes on.
 */
export interface ProviderAdmissionObservation {
  readonly sessionGeneration: number;
  readonly nativeSessionId: string | undefined;
  /**
   * The managed-capture candidate the adapter can prove at this publish
   * point: the exact final text blocks of the user message about to be
   * queued, plus the digest of the route profile the publish runs under.
   * Omitted when either cannot be proven — the send then proceeds
   * unlabelled; the field is never persisted or logged as a body.
   */
  readonly submissionCandidate?: {
    readonly textBlocks: readonly string[];
    readonly routeConfigSha256: string;
  };
}

/**
 * ProviderSendTurnAdmission — caller-supplied gate an adapter invokes
 * synchronously on each actual publish path: after the adapter's last await
 * and immediately before the prompt is queued. A false verdict publishes no
 * prompt and no turn boundary and leaves turn state unchanged; the send then
 * fails with the adapter's ordinary not-admitted error. The callback must
 * stay synchronous — adapters never await it.
 */
export interface ProviderSendTurnAdmission {
  readonly admit: (observed: ProviderAdmissionObservation) => boolean;
}

/**
 * ProviderSubmissionRoutePreview — the route a real send of the given input
 * would publish under on the session currently open for its thread: the
 * publish-time session generation, the native session id it resumes on, and
 * the digest of the route profile that publish would report. Computed
 * read-only from the pinned context — no SDK setters, no session creation.
 */
export interface ProviderSubmissionRoutePreview {
  readonly sessionGeneration: number;
  readonly nativeSessionId: string;
  readonly routeConfigSha256: string;
}

/**
 * ProviderMemoryAdmissionSupport — synchronous session-identity hooks a
 * memory-bearing send uses to bind an expected observation before the
 * caller's awaited rechecks and re-verify it at publish. Adapters that
 * cannot report both omit the field; memory handoffs then fail closed while
 * ordinary sends are unaffected.
 */
export interface ProviderMemoryAdmissionSupport {
  /** Generation of the session context open for the thread, or undefined. */
  readonly sessionGeneration: (threadId: ThreadId) => number | undefined;
  /** Pure parser: the native session id a resume cursor binds to. */
  readonly nativeSessionId: (resumeCursor: unknown) => string | undefined;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   *
   * `admission`, when supplied, is invoked synchronously inside the step that
   * publishes the prompt — after the adapter's last await — and a false
   * verdict publishes nothing and fails the send as not-admitted. Ordinary
   * calls omit it.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
    admission?: ProviderSendTurnAdmission,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Synchronous session-identity hooks for memory-bearing sends. Omitted
   * when the adapter cannot bind an observation to the context that actually
   * publishes; memory handoffs fail closed in that case.
   */
  readonly memoryAdmission?: ProviderMemoryAdmissionSupport;

  /**
   * Read-only projection of the route this exact send input would publish
   * under on the session currently open for its thread, computed without
   * invoking SDK setters or creating a session. Omitted when the adapter
   * cannot project its route; `undefined` means this input's route is
   * unprovable — no open session, missing resume or seed state, an
   * out-of-instance or unresolvable model selection, or launch args beyond
   * the accounted set.
   */
  readonly previewSubmissionRoute?: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderSubmissionRoutePreview | undefined>;

  /** Omitted when this adapter does not support manual context compaction. */
  readonly compaction?: ProviderCompaction<TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Respond to a structured user-input request.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Upload a thread to the provider when the adapter supports feedback.
   */
  readonly uploadFeedback?: (
    input: ProviderUploadFeedbackInput,
  ) => Effect.Effect<ProviderUploadFeedbackResult, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
