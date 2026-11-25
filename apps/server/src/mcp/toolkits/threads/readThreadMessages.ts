import type {
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { isCrewThreadTitle } from "@t3tools/shared/crew";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { isThreadRunning } from "../../../orchestration/decider.ts";
import type { ProjectionSnapshotQueryShape } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const THREAD_READ_MAX_MESSAGES = 20;
export const THREAD_READ_MAX_TEXT_CHARS = 12_000;
const TRUNCATED = "… [truncated]";

export interface ThreadReadResult {
  readonly messages: Array<{
    readonly role: "user" | "assistant";
    readonly text: string;
  }>;
  readonly truncated: boolean;
}

// A crew member's thread belongs to the crew tools: its lead reads it with crew_wait.
export const isCrewMember = (
  thread: Pick<OrchestrationThreadShell, "parentThreadId" | "title">,
): boolean => thread.parentThreadId != null || isCrewThreadTitle(thread.title);

export const deriveThreadListStatus = (
  thread: OrchestrationThreadShell,
): "running" | "idle" | "needs input" =>
  thread.hasPendingApprovals || thread.hasPendingUserInput
    ? "needs input"
    : isThreadRunning(thread)
      ? "running"
      : "idle";

export const formatThreadMessages = (
  detail: OrchestrationThreadDetailSnapshot,
): ThreadReadResult => {
  const all = detail.thread.messages.flatMap(({ role, text }) =>
    role === "user" || role === "assistant" ? [{ role, text }] : [],
  );
  let truncated = detail.page?.hasMore === true || all.length > THREAD_READ_MAX_MESSAGES;
  let remaining = THREAD_READ_MAX_TEXT_CHARS;
  const messages: Array<{ readonly role: "user" | "assistant"; readonly text: string }> = [];
  for (const message of all.slice(-THREAD_READ_MAX_MESSAGES).toReversed()) {
    if (remaining < TRUNCATED.length && message.text.length > remaining) {
      truncated = true;
      break;
    }
    const text =
      message.text.length <= remaining
        ? message.text
        : message.text.slice(0, remaining - TRUNCATED.length) + TRUNCATED;
    truncated ||= text !== message.text;
    remaining -= text.length;
    messages.push({ role: message.role, text });
  }
  return { messages: messages.toReversed(), truncated };
};

export const readThreadDetail = <E>(input: {
  readonly snapshots: ProjectionSnapshotQueryShape;
  readonly threadId: ThreadId;
  readonly isAllowed: (detail: OrchestrationThreadDetailSnapshot) => boolean;
  readonly onMissing: () => E;
  readonly onUnavailable: () => E;
}): Effect.Effect<OrchestrationThreadDetailSnapshot, E> =>
  Effect.gen(function* () {
    const detail = yield* input.snapshots
      .getThreadDetailSnapshot(input.threadId, { turnLimit: THREAD_READ_MAX_MESSAGES })
      .pipe(Effect.mapError(input.onUnavailable));
    if (Option.isNone(detail) || !input.isAllowed(detail.value)) {
      return yield* Effect.fail(input.onMissing());
    }
    return detail.value;
  });

export const readThreadMessages = <E>(input: {
  readonly snapshots: ProjectionSnapshotQueryShape;
  readonly threadId: ThreadId;
  readonly isAllowed: (detail: OrchestrationThreadDetailSnapshot) => boolean;
  readonly onMissing: () => E;
  readonly onUnavailable: () => E;
}): Effect.Effect<ThreadReadResult, E> =>
  readThreadDetail(input).pipe(Effect.map(formatThreadMessages));
