import {
  CommandId,
  EventId,
  MessageId,
  PROVIDER_DIFF_CHECKPOINT_REF_PREFIX,
  SELECTED_CHECK_RECEIPT_KIND,
  SelectedCheckReceipt,
  type OrchestrationEvent,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type ThreadGoal,
  ThreadId,
  deriveSelectedCheckState,
  selectedCheckReceiptId,
} from "@t3tools/contracts";
import { resolveCrew } from "@t3tools/shared/crew";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  CREW_AUDIT_SKIPPED_ACTIVITY,
  THREAD_GOAL_ACTIVITY,
  THREAD_GOAL_CREW_ACTIVITY_KINDS,
  threadGoalContinuePrompt,
  threadGoalCrewGate,
  threadGoalProgress,
  threadGoalVerdict,
} from "@t3tools/shared/threadGoal";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { isCrewThreadTitle } from "../crew/crewLogic.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Keeps a thread working toward its goal: after each completed turn it reads the agent's
 * verdict and either records the goal met or blocked, or sends an automatic continuation until
 * the goal's continuation budget is spent. Interrupted or failed turns stop the loop.
 */
export class ThreadGoalReactor extends Context.Service<
  ThreadGoalReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadGoalReactor") {}

export type ThreadGoalDecision =
  | { readonly kind: "none" }
  | { readonly kind: "met" }
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "exhausted" }
  | { readonly kind: "continue"; readonly attempt: number };

/** What a thread's goal waits on besides the turn itself; all off without Crew. */
export interface ThreadGoalCrewContext {
  /** Crew is on for the thread and staffs an auditor, so changed turns get audited. */
  readonly auditsTurns: boolean;
  /** The workspace is a git repository, so every turn's diff gets captured. */
  readonly diffExpected: boolean;
  /** When this server started; diffs, audits, and follow-ups in flight before then never land. */
  readonly serverStartedAt: string | null;
}

const NO_CREW: ThreadGoalCrewContext = {
  auditsTurns: false,
  diffExpected: false,
  serverStartedAt: null,
};

/** Why a goal stops when the agent reports it met but the latest Crew audit disagrees. */
export const CREW_AUDIT_OPEN_REASON = "the Crew audit still asks for changes";

/** Why a goal stops when the agent reports it met before the thread's selected checks confirm it. */
export const SELECTED_CHECKS_REVIEW_REASON =
  "the selected checks have not passed on the latest change; run them to confirm";

const decodeReceipt = Schema.decodeUnknownOption(SelectedCheckReceipt);

/**
 * Where the thread's selected checks stand on the work that ended at `since`: `none` when the
 * thread has no checks, `running` or `passed` for an attempt that started at or after `since`, and
 * `not-passed` otherwise, including when either time is unknown. The record is read the way the server reads its own, and judged the way
 * the Checks panel judges it.
 */
export function selectedChecksSince(
  threadId: ThreadId,
  activities: ReadonlyArray<
    Pick<OrchestrationThreadActivity, "id" | "kind" | "payload" | "sequence">
  >,
  since: string | null,
): "none" | "running" | "passed" | "not-passed" {
  const row = activities.find(
    (activity) =>
      activity.kind === SELECTED_CHECK_RECEIPT_KIND &&
      activity.id === selectedCheckReceiptId(threadId),
  );
  if (row === undefined) return "none";
  const receipt = Option.getOrNull(decodeReceipt(row.payload));
  if (receipt === null || receipt.threadId !== threadId || typeof row.sequence !== "number") {
    return "not-passed";
  }
  if (since === null || !(Date.parse(receipt.startedAt) >= Date.parse(since))) return "not-passed";
  const { state } = deriveSelectedCheckState({
    kind: "present",
    receipt,
    sequence: row.sequence,
  });
  return state === "running"
    ? "running"
    : state === "all-selected-passed"
      ? "passed"
      : "not-passed";
}

/** What to do once `thread`'s latest turn has ended, given its active goal. */
export function decideThreadGoal(
  goal: ThreadGoal,
  thread: Pick<
    OrchestrationThread,
    "id" | "latestTurn" | "session" | "messages" | "activities" | "checkpoints"
  >,
  crew: ThreadGoalCrewContext = NO_CREW,
): ThreadGoalDecision {
  const turn = thread.latestTurn;
  const status = thread.session?.status;
  if (
    !goal.active ||
    turn === null ||
    turn.state !== "completed" ||
    status === "running" ||
    status === "starting" ||
    Date.parse(turn.requestedAt) < Date.parse(goal.setAt)
  ) {
    return { kind: "none" };
  }
  const progress = threadGoalProgress(goal, thread.activities);
  const checks = () => selectedChecksSince(thread.id, thread.activities, turn.completedAt);
  // A goal held only for its checks is met once they pass on that same change.
  if (
    progress.status === "blocked" &&
    progress.blockedReason === SELECTED_CHECKS_REVIEW_REASON &&
    progress.handledTurnIds.has(turn.turnId)
  ) {
    return checks() === "passed" ? { kind: "met" } : { kind: "none" };
  }
  if (progress.status !== "working" || progress.handledTurnIds.has(turn.turnId)) {
    return { kind: "none" };
  }
  const gate = threadGoalCrewGate({
    turnId: turn.turnId,
    auditsTurns: crew.auditsTurns,
    diffExpected: crew.diffExpected,
    turnPredatesServer:
      crew.serverStartedAt !== null &&
      turn.completedAt !== null &&
      Date.parse(turn.completedAt) < Date.parse(crew.serverStartedAt),
    since: goal.setAt,
    liveSince: crew.serverStartedAt,
    checkpoints: thread.checkpoints,
    activities: thread.activities,
  });
  // The diff, audit, or Crew follow-up still on its way triggers the next review when it lands.
  if (gate === "wait" || gate === "crew-pending") return { kind: "none" };
  const reply =
    thread.messages.find((message) => message.id === turn.assistantMessageId) ??
    thread.messages.findLast(
      (message) => message.role === "assistant" && message.turnId === turn.turnId,
    );
  const verdict = threadGoalVerdict(reply?.text ?? "");
  // The agent reports the goal met but the latest audit still disagrees after its fix rounds. A
  // person settles that; another continuation would not even show the agent the audit.
  if (verdict?.kind === "met" && gate === "needs-changes") {
    return { kind: "blocked", reason: CREW_AUDIT_OPEN_REASON };
  }
  // A thread with selected checks needs them to pass on this change, not just the agent's word.
  if (verdict?.kind === "met") {
    const state = checks();
    if (state === "running") return { kind: "none" };
    if (state === "not-passed") return { kind: "blocked", reason: SELECTED_CHECKS_REVIEW_REASON };
  }
  if (verdict !== null) return verdict;
  return progress.continues >= goal.maxContinues
    ? { kind: "exhausted" }
    : { kind: "continue", attempt: progress.continues + 1 };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const providerService = yield* ProviderService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const serverStartedAt = DateTime.formatIso(yield* DateTime.now);

  /**
   * Whether the turn's diff will be captured, by the checkpoint reactor's own test: the provider
   * session's cwd first, then the thread's, and only in a git repository.
   */
  const capturesDiffs = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const session = (yield* providerService.listSessions()).find(
        (entry) => entry.threadId === threadId,
      );
      const context = yield* snapshots.getThreadCheckpointContext(threadId);
      const cwd = session?.cwd
        ? session.cwd
        : Option.match(context, {
            onNone: () => undefined,
            onSome: (entry) => entry.worktreePath ?? entry.workspaceRoot,
          });
      return cwd !== undefined && (yield* checkpointStore.isGitRepository(cwd));
    }).pipe(
      // Not knowing means not waiting: the goal is judged without the audit, never left stuck.
      Effect.orElseSucceed(() => false),
    );

  const review = Effect.fn("ThreadGoalReactor.review")(function* (threadId: ThreadId) {
    const settings = yield* settingsService.getSettings;
    const goal = settings.threadGoals[threadId];
    if (goal === undefined || !goal.active) return;
    const thread = yield* snapshots.getThreadDetailById(threadId, {
      activityKinds: [
        ...Object.values(THREAD_GOAL_ACTIVITY),
        ...THREAD_GOAL_CREW_ACTIVITY_KINDS,
        SELECTED_CHECK_RECEIPT_KIND,
      ],
    });
    if (Option.isNone(thread)) return;
    const turn = thread.value.latestTurn;
    const resolved = resolveCrew({
      settings: settings.crew,
      threadId,
      providers: yield* providerRegistry.getProviders,
      brain: thread.value.modelSelection,
    });
    const auditsTurns =
      resolved.enabled && resolved.roles.auditor !== null && !isCrewThreadTitle(thread.value.title);
    // Once the turn's real diff has landed there is nothing left to forecast.
    const diffLanded = thread.value.checkpoints.some(
      (checkpoint) =>
        checkpoint.turnId === turn?.turnId &&
        !checkpoint.checkpointRef.startsWith(PROVIDER_DIFF_CHECKPOINT_REF_PREFIX),
    );
    const decision = decideThreadGoal(goal, thread.value, {
      auditsTurns,
      diffExpected: auditsTurns && !diffLanded && (yield* capturesDiffs(threadId)),
      serverStartedAt,
    });
    if (turn === null || decision.kind === "none") return;
    const turnId = turn.turnId;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const record = (kind: string, summary: string, extra: Record<string, unknown> = {}) =>
      Effect.gen(function* () {
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(`server:goal:${kind}:${threadId}:${turnId}`),
          threadId,
          activity: {
            id: EventId.make(yield* uuid),
            tone: "info",
            kind,
            summary,
            payload: { goalId: goal.id, turnId, ...extra },
            turnId,
            createdAt,
          },
          createdAt,
        });
      });
    switch (decision.kind) {
      case "met":
        return yield* record(THREAD_GOAL_ACTIVITY.met, "Goal complete");
      case "blocked":
        return yield* record(THREAD_GOAL_ACTIVITY.blocked, `Goal blocked: ${decision.reason}`, {
          reason: decision.reason,
        });
      case "exhausted":
        return yield* record(
          THREAD_GOAL_ACTIVITY.exhausted,
          `Goal still open after ${goal.maxContinues} automatic continuations`,
        );
      case "continue":
        yield* record(
          THREAD_GOAL_ACTIVITY.continued,
          `Continuing toward the goal (${decision.attempt}/${goal.maxContinues})`,
          { attempt: decision.attempt },
        );
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`server:goal-turn:${threadId}:${turnId}`),
          threadId,
          message: {
            messageId: MessageId.make(yield* uuid),
            role: "user",
            text: threadGoalContinuePrompt(goal, decision.attempt),
            attachments: [],
          },
          runtimeMode: thread.value.runtimeMode,
          interactionMode: thread.value.interactionMode,
          createdAt,
        });
    }
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    review(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("thread goal review failed", { threadId, cause: Cause.pretty(cause) }),
      ),
    ),
  );

  // Leaving the running session status is the turn-end signal (see the projector). A turn's
  // diff, an audit's end, a failed diff capture, or a checks run can settle a goal that waited.
  const processEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.session-set":
        return event.payload.session.status !== "running" &&
          event.payload.session.status !== "starting"
          ? worker.enqueue(event.payload.threadId)
          : Effect.void;
      case "thread.turn-diff-completed":
        return worker.enqueue(event.payload.threadId);
      case "thread.activity-appended": {
        const { activity } = event.payload;
        const auditEnded =
          activity.kind === "task.completed" &&
          (activity.payload as { readonly crewRole?: unknown } | null)?.crewRole === "auditor";
        return auditEnded ||
          activity.kind === "checkpoint.capture.failed" ||
          activity.kind === CREW_AUDIT_SKIPPED_ACTIVITY ||
          activity.kind === SELECTED_CHECK_RECEIPT_KIND
          ? worker.enqueue(event.payload.threadId)
          : Effect.void;
      }
      default:
        return Effect.void;
    }
  };

  const start: ThreadGoalReactor["Service"]["start"] = Effect.fn("ThreadGoalReactor.start")(
    function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* forkParked(Stream.runForEach(events, processEvent));
      // A goal that waited on a diff, an audit, or a Crew follow-up when the server stopped has
      // nothing left to wake it, since that work lived in memory. Once the server is live, review
      // every open goal.
      yield* forkParked(
        Effect.gen(function* () {
          const settings = yield* settingsService.getSettings.pipe(
            Effect.orElseSucceed(() => null),
          );
          const goals = settings === null ? [] : Object.entries(settings.threadGoals);
          for (const [threadId, goal] of goals) {
            if (goal.active) yield* worker.enqueue(ThreadId.make(threadId));
          }
        }),
      );
    },
  );

  return { start, drain: worker.drain } satisfies ThreadGoalReactor["Service"];
});

export const layer = Layer.effect(ThreadGoalReactor, make);
