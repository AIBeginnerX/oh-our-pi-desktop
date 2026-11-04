import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { isCrewThreadTitle } from "../crew/crewLogic.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Opt-in (`continueUnfinishedPlans`, off by default). When a turn ends normally while the agent's
 * own plan or todo list still has unfinished steps, sends one automatic turn asking it to finish
 * them or say what blocks it. At most {@link PLAN_CONTINUATION_CAP} per user message, and only
 * while each continuation completes a step the previous turn had not.
 *
 * The plan comes from the `turn.plan.updated` activities the providers already emit (Codex,
 * Claude todos and tasks, OpenCode, and the ACP providers Cursor and Grok). A provider that emits
 * none never triggers anything. Every count and guard is read from persisted activities and
 * messages, and a review only follows a session leaving `running`, so a restart cannot fire a
 * continuation twice or wake an old thread.
 */
export class ThreadPlanContinuationReactor extends Context.Service<
  ThreadPlanContinuationReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ThreadPlanContinuationReactor") {}

/** Appended before the continuation turn is dispatched; its payload carries `turnId`, `messageId`, and step counts. */
export const PLAN_CONTINUED_ACTIVITY = "plan.continued";

const PLAN_UPDATED_ACTIVITY = "turn.plan.updated";

/** Automatic continuations per user message. */
export const PLAN_CONTINUATION_CAP = 2;

/**
 * How long after a turn ends it may still be continued. A review that runs later is not the one
 * that followed the turn (an old turn seen again after a setting change or a reconnect).
 */
export const PLAN_CONTINUATION_FRESH_MS = 2 * 60 * 1000;

const MAX_LISTED_STEPS = 10;
const MAX_STEP_CHARS = 200;

export type PlanContinuationDecision =
  | { readonly kind: "none" }
  | {
      readonly kind: "continue";
      readonly attempt: number;
      readonly completedSteps: number;
      readonly totalSteps: number;
      readonly remaining: ReadonlyArray<string>;
    };

const NONE: PlanContinuationDecision = { kind: "none" };

type ShellFacts = Pick<
  OrchestrationThreadShell,
  | "title"
  | "latestTurn"
  | "session"
  | "interactionMode"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
  | "archivedAt"
>;

/**
 * The cheap checks, from the thread's shell alone: a completed turn on a quiet, ready session of a
 * non-Crew thread in default mode. Plan mode proposes a plan for approval instead of working one.
 */
export function shellAllowsPlanContinuation(
  shell: ShellFacts,
  now: number,
  serverStartedAt: string,
): boolean {
  const turn = shell.latestTurn;
  if (
    turn === null ||
    turn.state !== "completed" ||
    turn.completedAt === null ||
    shell.archivedAt !== null ||
    shell.interactionMode === "plan" ||
    isCrewThreadTitle(shell.title) ||
    shell.session?.status !== "ready" ||
    shell.session.lastError !== null ||
    shell.hasPendingApprovals ||
    shell.hasPendingUserInput ||
    (shell.backgroundLiveness !== undefined && shell.backgroundLiveness !== null)
  ) {
    return false;
  }
  const completedAt = Date.parse(turn.completedAt);
  return (
    completedAt >= Date.parse(serverStartedAt) &&
    now - completedAt >= 0 &&
    now - completedAt <= PLAN_CONTINUATION_FRESH_MS
  );
}

interface PlanStep {
  readonly step: string;
  readonly completed: boolean;
}

type ActivityFacts = Pick<
  OrchestrationThread["activities"][number],
  "kind" | "turnId" | "payload" | "createdAt" | "sequence"
>;

/** The turn's most recent plan, or null when the provider sent none for it. */
function latestPlanOfTurn(
  activities: ReadonlyArray<ActivityFacts>,
  turnId: string,
): ReadonlyArray<PlanStep> | null {
  let latest: ActivityFacts | null = null;
  for (const activity of activities) {
    if (activity.kind !== PLAN_UPDATED_ACTIVITY || activity.turnId !== turnId) continue;
    if (
      latest === null ||
      (typeof activity.sequence === "number" && typeof latest.sequence === "number"
        ? activity.sequence >= latest.sequence
        : activity.createdAt >= latest.createdAt)
    ) {
      latest = activity;
    }
  }
  const raw = (latest?.payload as { readonly plan?: unknown } | null | undefined)?.plan;
  if (!Array.isArray(raw)) return null;
  const steps: PlanStep[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const { step, status } = entry as { readonly step?: unknown; readonly status?: unknown };
    if (typeof step === "string" && step.trim() !== "") {
      steps.push({ step: step.trim(), completed: status === "completed" });
    }
  }
  return steps.length === 0 ? null : steps;
}

/** What to send once `shell`'s latest turn has ended with its plan, if anything. */
export function decidePlanContinuation(input: {
  readonly shell: ShellFacts;
  readonly detail: Pick<OrchestrationThread, "messages" | "activities">;
  readonly now: number;
  readonly serverStartedAt: string;
}): PlanContinuationDecision {
  const { shell, detail } = input;
  if (!shellAllowsPlanContinuation(shell, input.now, input.serverStartedAt)) return NONE;
  const turn = shell.latestTurn;
  if (turn === null || turn.completedAt === null) return NONE;
  const completedAt = Date.parse(turn.completedAt);

  // A user message after the turn ended has its own turn on the way.
  if (
    detail.messages.some(
      (message) => message.role === "user" && Date.parse(message.createdAt) > completedAt,
    )
  ) {
    return NONE;
  }

  const continuations = detail.activities.filter(
    (activity) => activity.kind === PLAN_CONTINUED_ACTIVITY,
  );
  const payloadOf = (activity: ActivityFacts) =>
    (activity.payload ?? {}) as {
      readonly turnId?: unknown;
      readonly messageId?: unknown;
      readonly completedSteps?: unknown;
    };
  if (continuations.some((activity) => payloadOf(activity).turnId === turn.turnId)) return NONE;

  const plan = latestPlanOfTurn(detail.activities, turn.turnId);
  if (plan === null) return NONE;
  const completedSteps = plan.filter((step) => step.completed).length;
  if (completedSteps === plan.length) return NONE;

  // Continuations since the last message that is not one of ours.
  const ownMessageIds = new Set(
    continuations.flatMap((activity) => {
      const { messageId } = payloadOf(activity);
      return typeof messageId === "string" ? [messageId] : [];
    }),
  );
  let sent = 0;
  for (const message of detail.messages.toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  )) {
    if (message.role !== "user") continue;
    sent = ownMessageIds.has(message.id) ? sent + 1 : 0;
  }
  if (sent >= PLAN_CONTINUATION_CAP) return NONE;

  // A continuation that completed nothing new is not making progress.
  if (sent > 0) {
    const previous = payloadOf(continuations.at(-1)!).completedSteps;
    if (typeof previous !== "number" || completedSteps <= previous) return NONE;
  }

  return {
    kind: "continue",
    attempt: sent + 1,
    completedSteps,
    totalSteps: plan.length,
    remaining: plan.filter((step) => !step.completed).map((step) => step.step),
  };
}

export function planContinuationPrompt(
  decision: Extract<PlanContinuationDecision, { readonly kind: "continue" }>,
): string {
  const listed = decision.remaining
    .slice(0, MAX_LISTED_STEPS)
    .map((step) => `- ${step.slice(0, MAX_STEP_CHARS)}`);
  const more = decision.remaining.length - listed.length;
  return [
    `Your plan still has unfinished steps (automatic continuation ${decision.attempt} of ${PLAN_CONTINUATION_CAP}):`,
    ...listed,
    ...(more > 0 ? [`- and ${more} more`] : []),
    "Finish the remaining steps and mark them done. If you cannot, say plainly what is blocking you and stop.",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const serverStartedAt = DateTime.formatIso(yield* DateTime.now);

  const review = Effect.fn("ThreadPlanContinuationReactor.review")(function* (threadId: ThreadId) {
    const settings = yield* settingsService.getSettings;
    // Off by default: nothing below this line runs for anyone who has not switched it on.
    if (!settings.continueUnfinishedPlans) return;
    if (settings.threadGoals[threadId]?.active) return;

    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const shell = yield* snapshots.getThreadShellById(threadId);
    // Crew audits and follow-ups continue a lead thread themselves, so Crew threads are left alone.
    if (Option.isSome(shell) && (shell.value.crew?.enabled ?? settings.crew.enabled)) return;
    if (Option.isNone(shell) || !shellAllowsPlanContinuation(shell.value, now, serverStartedAt)) {
      return;
    }
    const detail = yield* snapshots.getThreadDetailById(threadId, {
      activityKinds: [PLAN_UPDATED_ACTIVITY, PLAN_CONTINUED_ACTIVITY],
    });
    if (Option.isNone(detail)) return;
    const decision = decidePlanContinuation({
      shell: shell.value,
      detail: detail.value,
      now,
      serverStartedAt,
    });
    const turn = shell.value.latestTurn;
    if (decision.kind === "none" || turn === null) return;

    const turnId = turn.turnId;
    const messageId = MessageId.make(yield* uuid);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // Recorded first: a crash between the two commands leaves the turn handled and unsent.
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:plan-continue:${threadId}:${turnId}`),
      threadId,
      activity: {
        id: EventId.make(yield* uuid),
        tone: "info",
        kind: PLAN_CONTINUED_ACTIVITY,
        summary: `Continuing unfinished plan (${decision.attempt}/${PLAN_CONTINUATION_CAP})`,
        payload: {
          turnId,
          messageId,
          attempt: decision.attempt,
          completedSteps: decision.completedSteps,
          totalSteps: decision.totalSteps,
        },
        turnId,
        createdAt,
      },
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:plan-turn:${threadId}:${turnId}`),
      threadId,
      message: {
        messageId,
        role: "user",
        text: planContinuationPrompt(decision),
        attachments: [],
      },
      runtimeMode: shell.value.runtimeMode,
      interactionMode: shell.value.interactionMode,
      createdAt,
    });
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    review(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("thread plan continuation review failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  // Leaving the running session status is the turn-end signal (see the projector).
  const processEvent = (event: OrchestrationEvent) =>
    event.type === "thread.session-set" &&
    event.payload.session.status !== "running" &&
    event.payload.session.status !== "starting"
      ? worker.enqueue(event.payload.threadId)
      : Effect.void;

  const start: ThreadPlanContinuationReactor["Service"]["start"] = Effect.fn(
    "ThreadPlanContinuationReactor.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies ThreadPlanContinuationReactor["Service"];
});

export const layer = Layer.effect(ThreadPlanContinuationReactor, make);
