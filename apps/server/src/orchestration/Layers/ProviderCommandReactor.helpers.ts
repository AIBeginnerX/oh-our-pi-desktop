import {
  CommandId,
  EventId,
  type OrchestrationThreadActivityTone,
  type ThreadId,
  type TurnId,
  type OrchestrationEvent,
  ProviderDriverKind,
  type OrchestrationSession,
  type RuntimeMode,
} from "@t3tools/contracts";
import { WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import * as Cause from "effect/Cause";
import type * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
  ProviderWorkspaceMissingError,
} from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import type { ProviderAdmissionObservation } from "../../provider/Services/ProviderAdapter.ts";
import { type ProviderSkillTrialRoute } from "../../provider/Services/ProviderService.ts";
import { type ThreadTitleMessage } from "../../textGeneration/ThreadTitleContext.ts";
import type { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  MEMORY_ECHO_WITHHELD_ERROR,
  lookupMemoryEchoThreadState,
  memoryEchoThreadShouldWithhold,
} from "../memoryEcho.ts";

export const isProviderAdapterProcessError = Schema.is(ProviderAdapterProcessError);
export const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
export const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);
export const isProviderWorkspaceMissingError = Schema.is(ProviderWorkspaceMissingError);
export const isProviderDriverKind = Schema.is(ProviderDriverKind);

/**
 * Reactor-internal marker: a project-memory hold that surfaced inside the
 * compaction fork. Carries the fixed user-facing detail only — never a cause —
 * so the compaction failure path can give it the bounded cleanup (activity +
 * queue/map teardown) without session restoration or session error writes.
 */
export class MemoryHoldFailure extends Schema.TaggedError<MemoryHoldFailure>()(
  "MemoryHoldFailure",
  {
    detail: Schema.String,
  },
) {}

/**
 * Two publish-step observations of one send must agree on every scalar and
 * every captured block to count as the same observation; any disagreement
 * drops the capture permanently rather than settling partial evidence.
 */
export const sameSubmissionObservation = (
  a: ProviderAdmissionObservation & ProviderSkillTrialRoute,
  b: ProviderAdmissionObservation & ProviderSkillTrialRoute,
): boolean => {
  const aCandidate = a.submissionCandidate;
  const bCandidate = b.submissionCandidate;
  return (
    a.sessionGeneration === b.sessionGeneration &&
    a.nativeSessionId === b.nativeSessionId &&
    a.providerInstanceId === b.providerInstanceId &&
    a.driverKind === b.driverKind &&
    (aCandidate === undefined
      ? bCandidate === undefined
      : bCandidate !== undefined &&
        aCandidate.routeConfigSha256 === bCandidate.routeConfigSha256 &&
        aCandidate.textBlocks.length === bCandidate.textBlocks.length &&
        aCandidate.textBlocks.every((text, index) => text === bCandidate.textBlocks[index]))
  );
};

export type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.meta-updated"
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested"
      | "thread.settled"
      | "thread.session-set";
  }
>;

/**
 * Keeps only a cause's interrupts. Rethrowing it preserves interrupt semantics
 * while dropping failure and defect reasons that may carry private content.
 * Call it only once `Cause.hasInterrupts(cause)` holds, so the result is never empty.
 */
export const interruptOnly = (cause: Cause.Cause<unknown>) =>
  Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason));

/**
 * A memory-failure report's claim on the session its failing ensure left
 * "starting": that ensure's last session-set sequence (null when it wrote none)
 * and the status to restore. Without it the report is activity-only.
 */
export type MemorySessionRestore = {
  readonly sessionSetSequence: number | null;
  readonly status: "ready" | "error";
};

export function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export const isCompactCommandMessage = (message: ThreadTitleMessage): boolean =>
  message.role === "user" &&
  (message.attachments?.length ?? 0) === 0 &&
  message.text.trim().toLowerCase() === "/compact";
export function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

export const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

export const HANDLED_TURN_START_KEY_MAX = 10_000;
export const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

export function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

export function isUnknownPendingApprovalRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request") ||
      detail.includes("unknown pending codex approval request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request") ||
    message.includes("unknown pending codex approval request")
  );
}

export function isUnknownPendingUserInputRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

export function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

export function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

export const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
  const failReason = cause.reasons.find(Cause.isFailReason);
  if (isProviderAdapterRequestError(failReason?.error)) {
    return failReason.error.detail;
  }
  if (isProviderAdapterProcessError(failReason?.error)) {
    return failReason.error.detail;
  }
  if (isProviderAdapterValidationError(failReason?.error)) {
    return failReason.error.issue;
  }
  if (isProviderWorkspaceMissingError(failReason?.error)) {
    return failReason.error.message;
  }
  return Cause.pretty(cause);
};

export const makeProviderFailureReporting = ({
  crypto,
  sql,
  orchestrationEngine,
}: {
  readonly crypto: Crypto.Crypto;
  readonly sql: SqlClient.SqlClient;
  readonly orchestrationEngine: OrchestrationEngineService["Service"];
}) => {
  /**
   * One provider diagnostic for this thread, judged against the durable
   * memory-send ledger at the moment of use: on a tainted or unavailable
   * thread the fixed withheld phrase is returned and the raw formatter never
   * runs; a clean thread keeps the raw text. No verdict is cached — every sink
   * calls this immediately before its write, so a clean judgment never
   * survives a projection fetch, a provider await, or another diagnostic
   * write. A lookup interruption, pure or mixed, fails with its original
   * cause so it reaches the enclosing worker or phase boundary untouched.
   * Ordinary lookup failures fail closed to unavailable inside the lookup;
   * they never reach this helper's failure channel.
   */
  const providerDiagnosticText = (threadId: ThreadId, raw: () => string) =>
    Effect.gen(function* () {
      const state = yield* lookupMemoryEchoThreadState(sql, threadId);
      return memoryEchoThreadShouldWithhold(state) ? MEMORY_ECHO_WITHHELD_ERROR : raw();
    });
  const providerDiagnosticTextPair = (
    threadId: ThreadId,
    primary: () => string,
    secondary: () => string,
  ) =>
    Effect.gen(function* () {
      const state = yield* lookupMemoryEchoThreadState(sql, threadId);
      const withhold = memoryEchoThreadShouldWithhold(state);
      return withhold
        ? { cause: MEMORY_ECHO_WITHHELD_ERROR, originalCause: MEMORY_ECHO_WITHHELD_ERROR }
        : { cause: primary(), originalCause: secondary() };
    });

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly tone?: OrchestrationThreadActivityTone;
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: input.tone ?? "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  return {
    providerDiagnosticText,
    providerDiagnosticTextPair,
    serverCommandId,
    serverEventId,
    appendProviderFailureActivity,
  };
};
