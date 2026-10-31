import type {
  OrchestrationProposedPlan,
  OrchestrationProposedPlanId,
  OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";

// The thread's task list (`turn.plan.updated`) and its proposed plan, as every client reads them.

export interface ActivePlanState {
  createdAt: string;
  turnId: TurnId | null;
  explanation?: string | null;
  steps: Array<{
    durationMs?: number;
    step: string;
    status: "pending" | "inProgress" | "completed";
  }>;
}

export interface LatestProposedPlanState {
  id: OrchestrationProposedPlanId;
  createdAt: string;
  updatedAt: string;
  turnId: TurnId | null;
  planMarkdown: string;
  implementedAt: string | null;
  implementationThreadId: ThreadId | null;
}

function planStateFromActivity(activity: OrchestrationThreadActivity): ActivePlanState | null {
  const payload =
    activity.payload && typeof activity.payload === "object"
      ? (activity.payload as Record<string, unknown>)
      : null;
  const rawPlan = payload?.plan;
  if (!Array.isArray(rawPlan)) {
    return null;
  }
  const steps: Array<{
    step: string;
    status: "pending" | "inProgress" | "completed";
  }> = [];
  for (const entry of rawPlan) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.step !== "string") {
      continue;
    }
    const status =
      record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
    steps.push({
      step: record.step,
      status,
    });
  }
  if (steps.length === 0) {
    return null;
  }
  return {
    createdAt: activity.createdAt,
    turnId: activity.turnId,
    ...(payload && "explanation" in payload
      ? { explanation: payload.explanation as string | null }
      : {}),
    steps,
  };
}

function addPlanStepDurations(
  plan: ActivePlanState,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ActivePlanState {
  const timings = new Map<string, { completedAt?: number; startedAt?: number }>();
  let planStartedAt: number | undefined;

  const keyedSteps = (steps: ActivePlanState["steps"]) => {
    const occurrences = new Map<string, number>();
    return steps.map((step) => {
      const occurrence = occurrences.get(step.step) ?? 0;
      occurrences.set(step.step, occurrence + 1);
      return { key: `${step.step}:${occurrence}`, step };
    });
  };

  for (const activity of activities) {
    const snapshot = planStateFromActivity(activity);
    const activityAt = Date.parse(activity.createdAt);
    if (!snapshot || Number.isNaN(activityAt)) continue;
    planStartedAt ??= activityAt;

    for (const { key, step } of keyedSteps(snapshot.steps)) {
      const timing = timings.get(key) ?? {};
      if (step.status === "inProgress" && timing.startedAt === undefined) {
        timing.startedAt = activityAt;
      }
      if (step.status === "completed" && timing.completedAt === undefined) {
        timing.completedAt = activityAt;
      }
      timings.set(key, timing);
    }
  }

  const durationByKey = new Map<string, number>();
  let previousCompletedAt = planStartedAt;
  for (const [key, timing] of [...timings.entries()].sort(
    (left, right) => (left[1].completedAt ?? Infinity) - (right[1].completedAt ?? Infinity),
  )) {
    const completedAt = timing.completedAt;
    const startedAt = timing.startedAt ?? previousCompletedAt;
    if (completedAt === undefined) continue;
    if (startedAt !== undefined && completedAt > startedAt) {
      durationByKey.set(key, completedAt - startedAt);
    }
    previousCompletedAt = completedAt;
  }

  return {
    ...plan,
    steps: keyedSteps(plan.steps).map(({ key, step }) => {
      if (step.status !== "completed") return step;
      const durationMs = durationByKey.get(key);
      return durationMs === undefined ? step : { ...step, durationMs };
    }),
  };
}

export function deriveActivePlanState(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  latestTurnId: TurnId | undefined,
): ActivePlanState | null {
  const allPlanActivities = activities
    .filter((activity) => activity.kind === "turn.plan.updated")
    .sort(compareActivitiesByOrder);
  // Prefer plan from the current turn; fall back to the most recent plan from any turn
  // so that TodoWrite tasks persist across follow-up messages.
  const latest = Option.firstSomeOf([
    ...(latestTurnId
      ? Arr.findLast(allPlanActivities, (activity) => activity.turnId === latestTurnId)
      : Option.none()),
    Arr.last(allPlanActivities),
  ]).pipe(Option.getOrNull);
  if (!latest) {
    return null;
  }
  const plan = planStateFromActivity(latest);
  if (!plan) return null;
  const matchingActivities = allPlanActivities.filter(
    (activity) => activity.turnId === latest.turnId,
  );
  const latestClearIndex = matchingActivities.findLastIndex(
    (activity) => planStateFromActivity(activity) === null,
  );
  return addPlanStepDurations(plan, matchingActivities.slice(latestClearIndex + 1));
}

export function findLatestProposedPlan(
  proposedPlans: ReadonlyArray<OrchestrationProposedPlan>,
  latestTurnId: TurnId | string | null | undefined,
): LatestProposedPlanState | null {
  if (latestTurnId) {
    const matchingTurnPlan = [...proposedPlans]
      .filter((proposedPlan) => proposedPlan.turnId === latestTurnId)
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
      )
      .at(-1);
    if (matchingTurnPlan) {
      return toLatestProposedPlanState(matchingTurnPlan);
    }
  }

  const latestPlan = [...proposedPlans]
    .sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id),
    )
    .at(-1);
  if (!latestPlan) {
    return null;
  }

  return toLatestProposedPlanState(latestPlan);
}

export function hasActionableProposedPlan(
  proposedPlan: LatestProposedPlanState | Pick<OrchestrationProposedPlan, "implementedAt"> | null,
): boolean {
  return proposedPlan !== null && proposedPlan.implementedAt === null;
}

function toLatestProposedPlanState(
  proposedPlan: OrchestrationProposedPlan,
): LatestProposedPlanState {
  return {
    id: proposedPlan.id,
    createdAt: proposedPlan.createdAt,
    updatedAt: proposedPlan.updatedAt,
    turnId: proposedPlan.turnId,
    planMarkdown: proposedPlan.planMarkdown,
    implementedAt: proposedPlan.implementedAt,
    implementationThreadId: proposedPlan.implementationThreadId,
  };
}

export function compareActivitiesByOrder(
  left: OrchestrationThreadActivity,
  right: OrchestrationThreadActivity,
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  const createdAtComparison = left.createdAt.localeCompare(right.createdAt);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  const lifecycleRankComparison =
    compareActivityLifecycleRank(left.kind) - compareActivityLifecycleRank(right.kind);
  if (lifecycleRankComparison !== 0) {
    return lifecycleRankComparison;
  }

  return left.id.localeCompare(right.id);
}

function compareActivityLifecycleRank(kind: string): number {
  if (kind.endsWith(".started") || kind === "tool.started") {
    return 0;
  }
  if (kind.endsWith(".progress") || kind.endsWith(".updated")) {
    return 1;
  }
  if (kind.endsWith(".completed") || kind.endsWith(".resolved")) {
    return 2;
  }
  return 1;
}

/** Prefix of the message the app sends when the user approves a plan. */
export const PLAN_IMPLEMENTATION_PROMPT_PREFIX = "PLEASE IMPLEMENT THIS PLAN:\n";

export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `${PLAN_IMPLEMENTATION_PROMPT_PREFIX}${planMarkdown.trim()}`;
}

export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

export function stripDisplayedPlanMarkdown(planMarkdown: string): string {
  const lines = planMarkdown.trimEnd().split(/\r?\n/);
  const sourceLines = lines[0] && /^\s{0,3}#{1,6}\s+/.test(lines[0]) ? lines.slice(1) : [...lines];
  while (sourceLines[0]?.trim().length === 0) {
    sourceLines.shift();
  }
  const firstHeadingMatch = sourceLines[0]?.match(/^\s{0,3}#{1,6}\s+(.+)$/);
  if (firstHeadingMatch?.[1]?.trim().toLowerCase() === "summary") {
    sourceLines.shift();
    while (sourceLines[0]?.trim().length === 0) {
      sourceLines.shift();
    }
  }
  return sourceLines.join("\n");
}
