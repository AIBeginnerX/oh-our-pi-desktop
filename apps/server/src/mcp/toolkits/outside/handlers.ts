import * as NodeCrypto from "node:crypto";
import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProviderApprovalOption,
  ThreadId,
  UserInputRequestedPayload,
  type OrchestrationThread,
  type RuntimeMode,
  type UserInputQuestion,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { resolveModelSelection } from "../../../scheduledPrompts/ScheduledPrompts.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import {
  clientRuntimeModeCeiling,
  isMcpClientInvocationScope,
  McpInvocationContext,
} from "../../McpInvocationContext.ts";
import {
  deriveThreadListStatus,
  formatThreadMessages,
  isCrewMember,
  readThreadDetail,
  THREAD_READ_MAX_MESSAGES,
} from "../threads/readThreadMessages.ts";
import { OutsideApprovalDecision, OutsideToolkit, OutsideToolRejected } from "./tools.ts";

const DEFAULT_THREAD_LIST_LIMIT = 50;
const MAX_MESSAGE_CHARS = 20_000;
const MAX_TITLE_CHARS = 120;
const MAX_APPROVAL_DETAIL_CHARS = 2_000;
const TRUNCATED = "… [truncated]";
const OUTSIDE_ID_PREFIX = "server:outside:";

// DEFAULT_APPROVAL_OPTIONS in apps/web/src/components/chat/ComposerPendingApprovalActions.tsx,
// without the session and permanent choices (see OutsideApprovalDecision).
const DEFAULT_OUTSIDE_APPROVAL_DECISIONS: ReadonlyArray<OutsideApprovalDecision> = [
  "accept",
  "decline",
  "cancel",
];

const USER_FACING_INVARIANT_DETAILS = new Set([
  "This question has already been answered.",
  "This question is no longer pending.",
  "Answer each question before sending.",
  "This question does not accept file references.",
]);

const RUNTIME_MODE_ORDER: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

const isApprovalRequestId = Schema.is(ApprovalRequestId);
const isProviderApprovalOption = Schema.is(ProviderApprovalOption);
const isOutsideApprovalDecision = Schema.is(OutsideApprovalDecision);
const decodeUserInputRequestedPayload = Schema.decodeUnknownOption(UserInputRequestedPayload);

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const clipText = (text: string, maxChars: number): string =>
  text.length <= maxChars ? text : text.slice(0, maxChars - TRUNCATED.length) + TRUNCATED;

const approvalDecisionsFromPayload = (
  payload: Record<string, unknown> | null,
): Array<OutsideApprovalDecision> => {
  const rawOptions = Array.isArray(payload?.options)
    ? payload.options.filter(isProviderApprovalOption)
    : [];
  const offered =
    rawOptions.length === 0
      ? DEFAULT_OUTSIDE_APPROVAL_DECISIONS
      : rawOptions.map((option) => option.decision).filter(isOutsideApprovalDecision);
  // A permission request asks to widen what the agent may do, so accepting it is not an
  // outside client's call.
  const widensPermissions = payload?.requestKind === "permission";
  return [...new Set(offered)].filter((decision) => !widensPermissions || decision !== "accept");
};

// includeApprovalDetail is false for read-only clients: the detail is the tool's own input
// (a command line, a file path), which oop_thread_read otherwise leaves out.
const collectPendingRequests = (
  thread: Pick<OrchestrationThread, "activities">,
  includeApprovalDetail: boolean,
) => {
  const pendingApprovals: Array<{
    readonly requestId: ApprovalRequestId;
    readonly summary: string;
    readonly detail?: string;
    readonly decisions: Array<OutsideApprovalDecision>;
  }> = [];
  const pendingQuestions: Array<{
    readonly requestId: ApprovalRequestId;
    readonly questions: Array<{
      readonly id: string;
      readonly header: string;
      readonly question: string;
      readonly options: Array<{
        readonly label: string;
        readonly description: string;
      }>;
      readonly multiSelect: boolean;
      readonly allowCustomAnswer: boolean;
    }>;
  }> = [];

  for (const [rawRequestId, activity] of openRequests(thread)) {
    if (!isApprovalRequestId(rawRequestId)) continue;
    if (activity.kind === "approval.requested") {
      const payload = asRecord(activity.payload);
      const rawDetail =
        includeApprovalDetail && typeof payload?.detail === "string" && payload.detail.length > 0
          ? clipText(payload.detail, MAX_APPROVAL_DETAIL_CHARS)
          : undefined;
      pendingApprovals.push({
        requestId: rawRequestId,
        summary: activity.summary,
        ...(rawDetail !== undefined ? { detail: rawDetail } : {}),
        decisions: approvalDecisionsFromPayload(payload),
      });
    } else if (activity.kind === "user-input.requested") {
      const decoded = decodeUserInputRequestedPayload(activity.payload);
      if (Option.isNone(decoded) || decoded.value.questions.length === 0) continue;
      pendingQuestions.push({
        requestId: rawRequestId,
        questions: decoded.value.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
          multiSelect: question.multiSelect === true,
          allowCustomAnswer: question.allowCustomAnswer !== false,
        })),
      });
    }
  }

  return { pendingApprovals, pendingQuestions };
};

// Produces the same Record<string, string | string[]> shape as buildPendingUserInputAnswers
// in apps/web/src/pendingUserInput.ts.
const buildValidatedUserInputAnswers = (
  questions: ReadonlyArray<UserInputQuestion>,
  rawAnswers: Readonly<Record<string, string | ReadonlyArray<string>>>,
): Effect.Effect<Record<string, string | Array<string>>, OutsideToolRejected> =>
  Effect.gen(function* () {
    const questionById = new Map(questions.map((question) => [question.id, question]));
    for (const key of Object.keys(rawAnswers)) {
      if (!questionById.has(key)) {
        return yield* reject(`Unknown question id "${key}".`);
      }
    }

    const resolved: Record<string, string | Array<string>> = {};
    for (const question of questions) {
      if (!Object.hasOwn(rawAnswers, question.id) || rawAnswers[question.id] === undefined) {
        return yield* reject(`Missing answer for question "${question.id}".`);
      }
      const raw = rawAnswers[question.id]!;
      const allowCustom = question.allowCustomAnswer !== false;
      const isMultiSelect = question.multiSelect === true;
      const findOption = (label: string) =>
        question.options.find((option) => option.label === label);

      if (typeof raw === "string") {
        const matched = findOption(raw);
        if (matched) {
          const value = matched.value ?? matched.label;
          resolved[question.id] = isMultiSelect ? [value] : value;
          continue;
        }
        const trimmed = raw.trim();
        if (trimmed.length === 0) {
          return yield* reject(`Answer for question "${question.id}" cannot be empty.`);
        }
        if (!allowCustom) {
          return yield* reject(
            `Answer "${raw}" for question "${question.id}" must match one of the listed options.`,
          );
        }
        resolved[question.id] = trimmed;
      } else {
        if (!isMultiSelect) {
          return yield* reject(`Question "${question.id}" does not accept multiple answers.`);
        }
        if (raw.length === 0) {
          return yield* reject(`Answer for question "${question.id}" cannot be empty.`);
        }
        const values: Array<string> = [];
        for (const entry of raw) {
          const matched = findOption(entry);
          if (!matched) {
            return yield* reject(
              allowCustom
                ? `Answer "${entry}" for question "${question.id}" is not a listed option. Send an answer of your own as a single string.`
                : `Answer "${entry}" for question "${question.id}" must match one of the listed options.`,
            );
          }
          values.push(matched.value ?? matched.label);
        }
        resolved[question.id] = Array.from(new Set(values));
      }
    }

    return resolved;
  });

const runtimeModeRank = (mode: RuntimeMode): number => RUNTIME_MODE_ORDER.indexOf(mode);

const capRuntimeMode = (requested: RuntimeMode, ceiling: RuntimeMode): RuntimeMode =>
  runtimeModeRank(requested) <= runtimeModeRank(ceiling) ? requested : ceiling;

const resolveThreadTitle = (messageBody: string, rawTitle: string | undefined): string => {
  const explicit = rawTitle?.trim();
  if (explicit && explicit.length > 0) {
    return explicit.slice(0, MAX_TITLE_CHARS).trim();
  }
  const firstLine = messageBody.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return firstLine.slice(0, MAX_TITLE_CHARS).trim() || "New thread";
};

const reject = (message: string) => new OutsideToolRejected({ message });
const busy = () =>
  reject(
    `${THREAD_MESSAGE_BUSY_DETAIL} Call oop_thread_read to inspect pending approvals or questions, then use oop_thread_approve, oop_thread_answer, or oop_thread_interrupt.`,
  );
const unavailable = () => reject("OOP data is unavailable.");
const missingProject = () => reject("Project not found.");
const missingThread = () => reject("Thread not found.");

const mapDispatchError = (
  error: { readonly _tag: string; readonly detail?: unknown },
  fallback: string,
) =>
  error._tag === "OrchestrationCommandInvariantError" &&
  typeof error.detail === "string" &&
  USER_FACING_INVARIANT_DETAILS.has(error.detail)
    ? reject(error.detail)
    : reject(fallback);

const requireClient = McpInvocationContext.pipe(
  Effect.filterOrFail(isMcpClientInvocationScope, () =>
    reject(
      "This tool is only available to external MCP clients. Agents running inside OOP should use list_threads, read_thread, or send_thread_message instead.",
    ),
  ),
);

const requireWritableClient = requireClient.pipe(
  Effect.filterOrFail(
    (scope) => scope.client.access !== "read-only",
    () =>
      reject(
        "This tool changes the environment, and this MCP client was approved for read-only access.",
      ),
  ),
);

const make = Effect.gen(function* () {
  const snapshots = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const turns = yield* ProjectionTurnRepository;
  const registry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const writeLock = yield* Semaphore.make(1);

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const shell = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(
        Effect.mapError(unavailable),
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(missingThread()), onSome: Effect.succeed }),
        ),
      );

  // turnLimit bounds which turns' activities are loaded. Tools that act on a request listed by
  // oop_thread_read pass the same window it reads, so a request it showed can be answered.
  const requireWritableThread = (threadId: ThreadId, turnLimit = 1) =>
    Effect.gen(function* () {
      const scope = yield* requireWritableClient;
      const target = yield* shell(threadId);
      if (target.archivedAt !== null) return yield* reject("The target thread is archived.");
      if (isCrewMember(target)) {
        return yield* reject("You cannot send a message to a crew member or task thread.");
      }

      const detail = yield* snapshots
        .getThreadDetailSnapshot(threadId, { turnLimit })
        .pipe(Effect.mapError(unavailable));
      if (Option.isNone(detail) || detail.value.thread.deletedAt !== null) {
        return yield* missingThread();
      }
      const thread = detail.value.thread;
      if (thread.archivedAt !== null) return yield* reject("The target thread is archived.");
      if (isCrewMember(thread)) {
        return yield* reject("You cannot send a message to a crew member or task thread.");
      }

      const ceiling = clientRuntimeModeCeiling(scope.client);
      if (runtimeModeRank(thread.runtimeMode) > runtimeModeRank(ceiling)) {
        return yield* reject(
          "This thread runs with more access than this MCP client was approved for.",
        );
      }

      return { scope, target, thread };
    });

  const appendOutsideActivity = (input: {
    readonly threadId: ThreadId;
    readonly activityId: EventId;
    readonly kind:
      | "outside-agent.message"
      | "outside-agent.approval"
      | "outside-agent.answer"
      | "outside-agent.interrupt";
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  }) =>
    engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`${OUTSIDE_ID_PREFIX}activity:${NodeCrypto.randomUUID()}`),
        threadId: input.threadId,
        activity: {
          id: input.activityId,
          kind: input.kind,
          tone: "info",
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.mapError(() => reject("Could not record the thread activity.")));

  return OutsideToolkit.of({
    oop_project_list: () =>
      Effect.gen(function* () {
        yield* requireClient;
        const projects = yield* snapshots.getProjectShells().pipe(Effect.mapError(unavailable));
        return {
          projects: projects.map((project) => ({
            id: project.id,
            title: project.title,
            workspaceRoot: project.workspaceRoot,
          })),
        };
      }),

    oop_thread_list: ({ projectId, allProjects, limit }) =>
      Effect.gen(function* () {
        yield* requireClient;
        const hasProjectId = projectId !== undefined;
        const hasAllProjects = allProjects === true;
        if (hasProjectId === hasAllProjects) {
          return yield* reject("Pass projectId, or allProjects: true for every project.");
        }
        const maxResults = limit ?? DEFAULT_THREAD_LIST_LIMIT;
        const { projects, threads } = yield* snapshots
          .getShellSnapshot()
          .pipe(Effect.mapError(unavailable));
        if (projectId !== undefined && !projects.some((project) => project.id === projectId)) {
          return yield* missingProject();
        }
        return {
          threads: threads
            .filter(
              (thread) =>
                (projectId === undefined || thread.projectId === projectId) &&
                thread.archivedAt === null &&
                !isCrewMember(thread),
            )
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, maxResults)
            .map((thread) => ({
              id: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              updatedAt: thread.updatedAt,
              status: deriveThreadListStatus(thread),
            })),
        };
      }),

    oop_thread_read: ({ threadId }) =>
      Effect.gen(function* () {
        const scope = yield* requireClient;
        const target = yield* shell(threadId);
        if (target.archivedAt !== null) {
          return yield* missingThread();
        }
        const detail = yield* readThreadDetail({
          snapshots,
          threadId,
          isAllowed: (snapshot) =>
            snapshot.thread.archivedAt === null && snapshot.thread.deletedAt === null,
          onMissing: missingThread,
          onUnavailable: unavailable,
        });
        const { messages, truncated } = formatThreadMessages(detail);
        const { pendingApprovals, pendingQuestions } = collectPendingRequests(
          detail.thread,
          scope.client.access !== "read-only",
        );
        return {
          status: deriveThreadListStatus(target),
          messages,
          truncated,
          pendingApprovals,
          pendingQuestions,
        };
      }),

    oop_thread_start: ({ projectId, message, title: rawTitle }) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const scope = yield* requireWritableClient;
          const body = message.trim();
          if (body.length === 0 || body.length > MAX_MESSAGE_CHARS) {
            return yield* reject("Message must be 1–20,000 characters after trimming.");
          }
          const project = yield* snapshots
            .getProjectShellById(projectId)
            .pipe(Effect.mapError(unavailable));
          if (Option.isNone(project)) {
            return yield* missingProject();
          }

          const settings = yield* settingsService.getSettings.pipe(Effect.mapError(unavailable));
          const providers = yield* registry.getProviders;
          const defaults = resolveProjectSettings(settings, projectId, project.value).settings;
          const modelSelection = resolveModelSelection(defaults.defaultModelSelection, providers);
          const runtimeMode = capRuntimeMode(
            defaults.defaultRuntimeMode,
            clientRuntimeModeCeiling(scope.client),
          );
          const interactionMode = DEFAULT_PROVIDER_INTERACTION_MODE;
          const title = resolveThreadTitle(body, rawTitle);
          const createdAt = yield* now;
          const threadId = ThreadId.make(`${OUTSIDE_ID_PREFIX}thread:${NodeCrypto.randomUUID()}`);
          const messageId = MessageId.make(
            `${OUTSIDE_ID_PREFIX}message:${NodeCrypto.randomUUID()}`,
          );
          const activityId = EventId.make(
            `${OUTSIDE_ID_PREFIX}activity:${NodeCrypto.randomUUID()}`,
          );

          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* engine
                .dispatch({
                  type: "thread.create",
                  commandId: CommandId.make(
                    `${OUTSIDE_ID_PREFIX}create:${NodeCrypto.randomUUID()}`,
                  ),
                  threadId,
                  projectId,
                  title,
                  modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: null,
                  worktreePath: null,
                  createdAt,
                })
                .pipe(Effect.mapError(() => reject("Could not create the thread.")));
              yield* engine
                .dispatch({
                  type: "thread.turn.start",
                  commandId: CommandId.make(`${OUTSIDE_ID_PREFIX}turn:${NodeCrypto.randomUUID()}`),
                  threadId,
                  message: {
                    messageId,
                    role: "user",
                    text: body,
                    attachments: [],
                  },
                  runtimeMode,
                  interactionMode,
                  createdAt,
                })
                .pipe(Effect.mapError(() => reject("Could not start a turn in the new thread.")));
              const appended = yield* appendOutsideActivity({
                threadId,
                activityId,
                kind: "outside-agent.message",
                summary: `Message from ${scope.client.label} over MCP`,
                payload: {
                  sessionId: scope.client.sessionId,
                  clientLabel: scope.client.label,
                  messageId,
                },
                createdAt,
              }).pipe(Effect.exit);
              if (Exit.isFailure(appended)) {
                return yield* reject(
                  "The thread was created and its turn started, but its activity could not be recorded. Do not resend.",
                );
              }
              return { threadId, title };
            }),
          );
        }),
      ),

    oop_thread_send: ({ threadId, message }) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          yield* requireWritableClient;
          const body = message.trim();
          if (body.length === 0 || body.length > MAX_MESSAGE_CHARS) {
            return yield* reject("Message must be 1–20,000 characters after trimming.");
          }

          const { scope, target, thread } = yield* requireWritableThread(threadId);

          const pending = yield* turns
            .getPendingTurnStartByThreadId({ threadId })
            .pipe(Effect.mapError(unavailable));
          const createdAt = yield* now;
          if (
            target.hasPendingApprovals ||
            target.hasPendingUserInput ||
            isThreadRunning(thread) ||
            openRequests(thread).size > 0 ||
            Option.isSome(pending) ||
            hasQueuedTurnStartForThread(thread, createdAt)
          ) {
            return yield* busy();
          }

          const messageId = MessageId.make(
            `${OUTSIDE_ID_PREFIX}message:${NodeCrypto.randomUUID()}`,
          );
          const activityId = EventId.make(
            `${OUTSIDE_ID_PREFIX}activity:${NodeCrypto.randomUUID()}`,
          );
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* engine
                .dispatch({
                  type: "thread.turn.start",
                  // Reuse THREAD_MESSAGE_COMMAND_PREFIX + messageId so the decider's atomic
                  // busy recheck protects against races between the snapshot read and dispatch.
                  commandId: CommandId.make(`${THREAD_MESSAGE_COMMAND_PREFIX}${messageId}`),
                  threadId,
                  message: {
                    messageId,
                    role: "user",
                    text: body,
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
              const appended = yield* appendOutsideActivity({
                threadId,
                activityId,
                kind: "outside-agent.message",
                summary: `Message from ${scope.client.label} over MCP`,
                payload: {
                  sessionId: scope.client.sessionId,
                  clientLabel: scope.client.label,
                  messageId,
                },
                createdAt,
              }).pipe(Effect.exit);
              if (Exit.isFailure(appended)) {
                return yield* reject(
                  "The message was delivered, but its activity could not be recorded. Do not resend.",
                );
              }
              return { threadId, title: thread.title };
            }),
          );
        }),
      ),

    oop_thread_approve: ({ threadId, requestId, decision }) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const { scope, thread } = yield* requireWritableThread(
            threadId,
            THREAD_READ_MAX_MESSAGES,
          );
          const request = openRequests(thread).get(requestId);
          if (request === undefined || request.kind !== "approval.requested") {
            return yield* reject("This approval is no longer pending.");
          }

          const allowedDecisions = approvalDecisionsFromPayload(asRecord(request.payload));
          if (!allowedDecisions.includes(decision)) {
            return yield* reject(
              allowedDecisions.length > 0
                ? `This approval only accepts: ${allowedDecisions.join(", ")}.`
                : "This approval offers no decisions available to external MCP clients.",
            );
          }

          const createdAt = yield* now;
          const activityId = EventId.make(
            `${OUTSIDE_ID_PREFIX}activity:${NodeCrypto.randomUUID()}`,
          );
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* engine
                .dispatch({
                  type: "thread.approval.respond",
                  commandId: CommandId.make(
                    `${OUTSIDE_ID_PREFIX}approval:${NodeCrypto.randomUUID()}`,
                  ),
                  threadId,
                  requestId,
                  decision,
                  createdAt,
                })
                .pipe(
                  Effect.mapError((error) =>
                    mapDispatchError(error, "Could not respond to the approval request."),
                  ),
                );
              const appended = yield* appendOutsideActivity({
                threadId,
                activityId,
                kind: "outside-agent.approval",
                summary: `${scope.client.label} answered an approval (${decision}) over MCP`,
                payload: {
                  sessionId: scope.client.sessionId,
                  clientLabel: scope.client.label,
                  requestId,
                  decision,
                },
                createdAt,
              }).pipe(Effect.exit);
              if (Exit.isFailure(appended)) {
                return yield* reject(
                  "The approval decision was sent, but its activity could not be recorded. Do not repeat it.",
                );
              }
              return { threadId, requestId, decision };
            }),
          );
        }),
      ),

    oop_thread_answer: ({ threadId, requestId, answers }) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const { scope, thread } = yield* requireWritableThread(
            threadId,
            THREAD_READ_MAX_MESSAGES,
          );
          const request = openRequests(thread).get(requestId);
          if (request === undefined || request.kind !== "user-input.requested") {
            return yield* reject("This question is no longer pending.");
          }
          const decoded = decodeUserInputRequestedPayload(request.payload);
          if (Option.isNone(decoded) || decoded.value.questions.length === 0) {
            return yield* reject("This question is no longer pending.");
          }

          const validatedAnswers = yield* buildValidatedUserInputAnswers(
            decoded.value.questions,
            answers,
          );
          const createdAt = yield* now;
          const activityId = EventId.make(
            `${OUTSIDE_ID_PREFIX}activity:${NodeCrypto.randomUUID()}`,
          );
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* engine
                .dispatch({
                  type: "thread.user-input.respond",
                  commandId: CommandId.make(
                    `${OUTSIDE_ID_PREFIX}answer:${NodeCrypto.randomUUID()}`,
                  ),
                  threadId,
                  requestId,
                  answers: validatedAnswers,
                  createdAt,
                })
                .pipe(
                  Effect.mapError((error) =>
                    mapDispatchError(error, "Could not submit the answer."),
                  ),
                );
              const appended = yield* appendOutsideActivity({
                threadId,
                activityId,
                kind: "outside-agent.answer",
                summary: `${scope.client.label} answered a question over MCP`,
                payload: {
                  sessionId: scope.client.sessionId,
                  clientLabel: scope.client.label,
                  requestId,
                },
                createdAt,
              }).pipe(Effect.exit);
              if (Exit.isFailure(appended)) {
                return yield* reject(
                  "The answer was submitted, but its activity could not be recorded. Do not repeat it.",
                );
              }
              return { threadId, requestId };
            }),
          );
        }),
      ),

    oop_thread_interrupt: ({ threadId }) =>
      writeLock.withPermits(1)(
        Effect.gen(function* () {
          const { scope, target, thread } = yield* requireWritableThread(threadId);
          if (
            !isThreadRunning(thread) &&
            openRequests(thread).size === 0 &&
            !target.hasPendingApprovals &&
            !target.hasPendingUserInput
          ) {
            return yield* reject("The thread is not running.");
          }

          const createdAt = yield* now;
          const activityId = EventId.make(
            `${OUTSIDE_ID_PREFIX}activity:${NodeCrypto.randomUUID()}`,
          );
          return yield* Effect.uninterruptible(
            Effect.gen(function* () {
              yield* engine
                .dispatch({
                  type: "thread.turn.interrupt",
                  commandId: CommandId.make(
                    `${OUTSIDE_ID_PREFIX}interrupt:${NodeCrypto.randomUUID()}`,
                  ),
                  threadId,
                  createdAt,
                })
                .pipe(
                  Effect.mapError((error) =>
                    mapDispatchError(error, "Could not interrupt the thread."),
                  ),
                );
              const appended = yield* appendOutsideActivity({
                threadId,
                activityId,
                kind: "outside-agent.interrupt",
                summary: `${scope.client.label} interrupted the turn over MCP`,
                payload: {
                  sessionId: scope.client.sessionId,
                  clientLabel: scope.client.label,
                },
                createdAt,
              }).pipe(Effect.exit);
              if (Exit.isFailure(appended)) {
                return yield* reject(
                  "The interrupt was sent, but its activity could not be recorded. Do not repeat it.",
                );
              }
              return { threadId };
            }),
          );
        }),
      ),
  });
});

export const OutsideToolkitHandlersLive = OutsideToolkit.toLayer(make);
