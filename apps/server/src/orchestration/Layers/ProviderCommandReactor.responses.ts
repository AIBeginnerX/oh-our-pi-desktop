import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type { ProviderService } from "../../provider/Services/ProviderService.ts";
import {
  type ProviderIntentEvent,
  isUnknownPendingApprovalRequestError,
  isUnknownPendingUserInputRequestError,
  stalePendingRequestDetail,
  type makeProviderFailureReporting,
} from "./ProviderCommandReactor.helpers.ts";
import type { makeProviderSessionOperations } from "./ProviderCommandReactor.session.ts";

export const makeProviderResponseOperations = ({
  providerService,
  providerDiagnosticText,
  appendProviderFailureActivity,
  resolveThreadShell,
}: {
  readonly providerService: ProviderService["Service"];
  readonly providerDiagnosticText: ReturnType<
    typeof makeProviderFailureReporting
  >["providerDiagnosticText"];
  readonly appendProviderFailureActivity: ReturnType<
    typeof makeProviderFailureReporting
  >["appendProviderFailureActivity"];
  readonly resolveThreadShell: ReturnType<
    typeof makeProviderSessionOperations
  >["resolveThreadShell"];
}) => {
  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          // Only the raw branch is judged: stale-pending classification and
          // its fixed phrase stay untouched.
          (isUnknownPendingApprovalRequestError(cause)
            ? Effect.succeed(stalePendingRequestDetail("approval", event.payload.requestId))
            : providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause))
          ).pipe(
            Effect.flatMap((detail) =>
              appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.approval.respond.failed",
                summary: "Provider approval response failed",
                detail,
                turnId: null,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              }),
            ),
          ),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
          ...(event.payload.attachmentsByQuestionId
            ? { attachmentsByQuestionId: event.payload.attachmentsByQuestionId }
            : {}),
        })
        .pipe(
          Effect.catchCause((cause) =>
            // Only the raw branch is judged: stale-pending classification and
            // its fixed phrase stay untouched.
            (isUnknownPendingUserInputRequestError(cause)
              ? Effect.succeed(stalePendingRequestDetail("user-input", event.payload.requestId))
              : providerDiagnosticText(event.payload.threadId, () => Cause.pretty(cause))
            ).pipe(
              Effect.flatMap((detail) =>
                appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.user-input.respond.failed",
                  summary: "Provider user input response failed",
                  detail,
                  turnId: null,
                  createdAt: event.payload.createdAt,
                  requestId: event.payload.requestId,
                }),
              ),
            ),
          ),
        );
    },
  );

  return { processApprovalResponseRequested, processUserInputResponseRequested };
};
