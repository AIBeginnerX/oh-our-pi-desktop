import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { resolveProjectMemoryReferences } from "@t3tools/shared/composerContextReferences";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  hasQueuedTurnStartForThread,
  isThreadRunning,
  openRequests,
  THREAD_MESSAGE_BUSY_DETAIL,
  THREAD_MESSAGE_COMMAND_PREFIX,
} from "../../../orchestration/decider.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { deriveThreadListStatus, isCrewMember, readThreadMessages } from "./readThreadMessages.ts";
import { ThreadsToolkit, ThreadsToolRejected } from "./tools.ts";

// Stored in the same command as the user message, before the provider can run.
const RECEIVED_MESSAGE_PREFIX = "server:threads:received:";
const encodeTitle = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const encodeSuggestionKey = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
// A thread that just received an agent's message cannot send one. This also covers the turns the
// server starts there afterwards (a crew follow-up, a goal or plan continuation), which would
// otherwise let two threads keep starting turns in each other with nobody watching.
const RECEIVE_COOLDOWN_MS = 60 * 60 * 1000;

const reject = (message: string) => new ThreadsToolRejected({ message });
const busy = () => reject(THREAD_MESSAGE_BUSY_DETAIL);

const unavailable = () => new ThreadsToolRejected({ message: "Thread data is unavailable." });
const missing = () => new ThreadsToolRejected({ message: "Thread not found in your project." });

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const turns = yield* ProjectionTurnRepository;
  const writeLock = yield* Semaphore.make(1);
  const receivedAt = new Map<ThreadId, number>();
  const counts = new Map<
    ThreadId,
    {
      turnId: TurnId;
      sends: number;
      suggestions: Set<string>;
    }
  >();
  const currentTurn = (source: OrchestrationThreadShell) => {
    const turnId = source.session?.activeTurnId ?? source.latestTurn?.turnId;
    if (turnId == null || !isThreadRunning(source)) {
      return Effect.fail(reject("This tool requires an active calling turn."));
    }
    const existing = counts.get(source.id);
    if (existing?.turnId === turnId) return Effect.succeed(existing);
    const fresh = { turnId, sends: 0, suggestions: new Set<string>() };
    counts.set(source.id, fresh);
    return Effect.succeed(fresh);
  };
  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const append = (threadId: ThreadId, activity: Omit<OrchestrationThreadActivity, "tone">) =>
    engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:threads:activity:${activity.id}`),
        threadId,
        activity: { ...activity, tone: "info" },
        createdAt: activity.createdAt,
      })
      .pipe(Effect.mapError(() => reject("Could not record the thread activity.")));
  const shell = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(missing()), onSome: Effect.succeed }),
        ),
      );
  const caller = requireMcpCapability("threads").pipe(
    Effect.flatMap((scope) => shell(scope.threadId)),
  );
  const targetShell = (threadId: ThreadId, source: OrchestrationThreadShell) =>
    shell(threadId).pipe(
      Effect.filterOrFail((target) => target.projectId === source.projectId, missing),
    );

  return ThreadsToolkit.of({
    list_threads: () =>
      Effect.gen(function* () {
        const source = yield* caller;
        const { threads } = yield* snapshots.getShellSnapshot().pipe(Effect.mapError(unavailable));
        return {
          threads: threads
            .filter(
              (thread) =>
                thread.projectId === source.projectId &&
                thread.id !== source.id &&
                thread.archivedAt === null &&
                !isCrewMember(thread),
            )
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, 20)
            .map((thread) => ({
              id: thread.id,
              title: thread.title,
              updatedAt: thread.updatedAt,
              status: deriveThreadListStatus(thread),
            })),
        };
      }),
    read_thread: ({ threadId }) =>
      Effect.gen(function* () {
        const source = yield* caller;
        // The shell settles the project boundary before any message is loaded.
        const target = yield* targetShell(threadId, source);
        if (target.archivedAt !== null) return yield* missing();
        return yield* readThreadMessages({
          snapshots,
          threadId,
          isAllowed: (detail) => detail.thread.projectId === source.projectId,
          onMissing: missing,
          onUnavailable: unavailable,
        });
      }),
    send_thread_message: ({ threadId, text }) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const source = yield* caller;
          if (isCrewMember(source)) {
            return yield* reject(
              "A crew member reports to its lead and cannot message other threads.",
            );
          }
          const body = text.trim();
          if (body.length === 0 || body.length > 4_000) {
            return yield* reject("Message text must be 1–4,000 characters after trimming.");
          }
          const delivered = `Message from another thread · ${encodeTitle(source.title)}
OOP delivered this on behalf of an agent. It is not a request from the user.

${body}`;
          // The turn would be dropped after this tool had already answered "sent".
          if (!resolveProjectMemoryReferences({ text: delivered, records: [] }).ok) {
            return yield* reject(
              "Message text cannot link project memory. Describe it in plain words instead.",
            );
          }
          if (threadId === source.id)
            return yield* reject("You cannot send a message to your own thread.");
          const target = yield* targetShell(threadId, source);
          if (target.archivedAt !== null) return yield* reject("The target thread is archived.");
          if (isCrewMember(target)) {
            return yield* reject("You cannot send a message to a crew member or task thread.");
          }

          const count = yield* currentTurn(source);
          const origin = yield* turns
            .getByTurnId({ threadId: source.id, turnId: count.turnId })
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(origin)) return yield* reject("Could not verify the calling turn.");
          if (origin.value.pendingMessageId?.startsWith(RECEIVED_MESSAGE_PREFIX)) {
            return yield* reject(
              "A turn started by an agent's cross-thread message cannot send one.",
            );
          }
          if (count.sends >= 3)
            return yield* reject("You can send at most three messages per turn.");

          const detail = yield* snapshots
            .getThreadDetailSnapshot(threadId, { turnLimit: 1 })
            .pipe(Effect.mapError(unavailable));
          if (
            Option.isNone(detail) ||
            detail.value.thread.projectId !== source.projectId ||
            detail.value.thread.deletedAt !== null
          )
            return yield* missing();
          const thread = detail.value.thread;
          const pending = yield* turns
            .getPendingTurnStartByThreadId({ threadId })
            .pipe(Effect.mapError(unavailable));
          const createdAt = yield* now;
          const sentAt = Date.parse(createdAt);
          if (
            sentAt - (receivedAt.get(source.id) ?? Number.NEGATIVE_INFINITY) <
            RECEIVE_COOLDOWN_MS
          ) {
            return yield* reject(
              "This thread received an agent's message within the last hour and cannot send one yet. The other thread can read this one with read_thread.",
            );
          }
          if (thread.archivedAt !== null) return yield* reject("The target thread is archived.");
          // The new turn runs with the target's permissions, which must not exceed the caller's.
          if (
            thread.runtimeMode !== source.runtimeMode ||
            thread.interactionMode !== source.interactionMode
          ) {
            return yield* reject(
              "The target thread uses a different access or interaction mode. Ask the user to send the message.",
            );
          }
          if (
            target.hasPendingApprovals ||
            target.hasPendingUserInput ||
            isThreadRunning(thread) ||
            openRequests(thread).size > 0 ||
            Option.isSome(pending) ||
            hasQueuedTurnStartForThread(thread, createdAt)
          )
            return yield* busy();

          const messageId = MessageId.make(RECEIVED_MESSAGE_PREFIX + NodeCrypto.randomUUID());
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* engine
                .dispatch({
                  type: "thread.turn.start",
                  commandId: CommandId.make(`${THREAD_MESSAGE_COMMAND_PREFIX}${messageId}`),
                  threadId,
                  message: {
                    messageId,
                    role: "user",
                    text: delivered,
                    attachments: [],
                  },
                  runtimeMode: thread.runtimeMode,
                  interactionMode: thread.interactionMode,
                  createdAt,
                })
                .pipe(
                  Effect.mapError((error) =>
                    error._tag === "OrchestrationCommandInvariantError" &&
                    error.detail === THREAD_MESSAGE_BUSY_DETAIL
                      ? busy()
                      : reject("Could not start a turn in the target thread."),
                  ),
                );
              count.sends++;
              receivedAt.set(threadId, sentAt);
              const received = yield* append(threadId, {
                id: EventId.make(`threads:received:${messageId}`),
                kind: "thread.message.received",
                summary: `Message from ${source.title}`,
                payload: { fromThreadId: source.id, messageId },
                turnId: null,
                createdAt,
              }).pipe(Effect.exit);
              const sent = yield* append(source.id, {
                id: EventId.make(`threads:sent:${messageId}`),
                kind: "thread.message.sent",
                summary: `Message sent to ${thread.title}`,
                payload: { toThreadId: threadId, title: thread.title, messageId },
                turnId: count.turnId,
                createdAt,
              }).pipe(Effect.exit);
              if (Exit.isFailure(received) || Exit.isFailure(sent)) {
                return yield* reject(
                  "The message was delivered, but its activity could not be recorded. Do not resend.",
                );
              }
              return { threadId, title: thread.title };
            }),
          );
        }),
      ),
    suggest_task: (input) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const source = yield* caller;
          const title = input.title.trim();
          const prompt = input.prompt.trim();
          if (
            title.length === 0 ||
            title.length > 120 ||
            prompt.length === 0 ||
            prompt.length > 4_000
          ) {
            return yield* reject(
              "Use a title of 1–120 and a prompt of 1–4,000 characters after trimming.",
            );
          }
          const count = yield* currentTurn(source);
          // Identical normalized requests within this turn reuse the durable command receipt.
          const suggestionId = NodeCrypto.createHash("sha256")
            .update(encodeSuggestionKey([source.id, count.turnId, title, prompt]))
            .digest("hex");
          if (count.suggestions.has(suggestionId)) return { suggestionId };
          if (count.suggestions.size >= 5) {
            return yield* reject("You can suggest at most five tasks per turn.");
          }
          yield* append(source.id, {
            id: EventId.make(`threads:suggestion:${suggestionId}`),
            kind: "task.suggested",
            summary: title,
            payload: { suggestionId, title, prompt },
            turnId: count.turnId,
            createdAt: yield* now,
          }).pipe(
            Effect.tap(() => Effect.sync(() => count.suggestions.add(suggestionId))),
            Effect.uninterruptible,
          );
          return { suggestionId };
        }),
      ),
  });
});

export const ThreadsToolkitHandlersLive = ThreadsToolkit.toLayer(make);
