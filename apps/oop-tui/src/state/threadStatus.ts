import {
  OWNED_USAGE_ACTIVITY_KIND,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { derivePendingRequests } from "@t3tools/client-runtime/pending-requests";

export type ThreadPhase = "idle" | "working" | "approval" | "input" | "error";

export interface PlanStep {
  readonly step: string;
  readonly status: "pending" | "inProgress" | "completed";
}

/** A sub-agent the turn started and has not seen finish. */
export interface AgentRow {
  readonly id: string;
  readonly name: string;
  /** What it is doing now (its last tool or progress line), when it said. */
  readonly work: string | null;
  /** Epoch milliseconds from the server's clock; null when the activity carried no usable time. */
  readonly startedAt: number | null;
}

export interface ContextUsage {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  /** 0-100, null when the provider reported no window size. */
  readonly percent: number | null;
}

export interface ThreadStatus {
  readonly phase: ThreadPhase;
  /** A turn is in flight, so Esc/Ctrl-C should interrupt it. */
  readonly interruptible: boolean;
  readonly runningTool: string | null;
  /** The running tool's detail line (a command, a path), when it has one. */
  readonly runningToolDetail: string | null;
  readonly pending: ReturnType<typeof derivePendingRequests>;
  readonly lastError: string | null;
  /** When the server says the running turn started (epoch ms); null when idle or not reported. */
  readonly turnStartedAt: number | null;
  /** The running turn's plan, in order; empty when it has none or no turn is running. */
  readonly plan: ReadonlyArray<PlanStep>;
  /** Sub-agents of the running turn that have not finished. */
  readonly agents: ReadonlyArray<AgentRow>;
  /** The last context-window report of the thread. */
  readonly context: ContextUsage | null;
  /** What the thread's Claude sessions have cost, as far as the activities in view show; null when none reported one. */
  readonly costUsd: number | null;
}

const SCAN_LIMIT = 200;

const recordOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

const numberOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const firstLineOf = (value: string): string | null => value.split("\n")[0]?.trim() || null;

/** The running turn's unfinished tool; tools of earlier turns never count, whatever they left open. */
const findRunningTool = (
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  turnId: string,
): { readonly title: string | null; readonly detail: string | null } | null => {
  const finished = new Set<string>();
  const lowest = Math.max(0, activities.length - SCAN_LIMIT);
  for (let index = activities.length - 1; index >= lowest; index -= 1) {
    const activity = activities[index] as OrchestrationThreadActivity;
    if (activity.turnId !== null && activity.turnId !== turnId) continue;
    const payload = recordOf(activity.payload);
    const id = typeof payload.toolCallId === "string" ? payload.toolCallId : null;
    if (activity.kind === "tool.completed" || activity.kind === "tool.denied") {
      if (id !== null) finished.add(id);
    } else if (activity.kind === "tool.started" && (id === null || !finished.has(id))) {
      const title = typeof payload.title === "string" ? payload.title : activity.summary;
      const detail = textOf(payload.detail);
      return { title: firstLineOf(title), detail: detail === null ? null : firstLineOf(detail) };
    }
  }
  return null;
};

const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "stopped",
  "interrupted",
  "killed",
  "idle",
]);

interface ActivityFacts {
  readonly plan: { readonly turnId: string | null; readonly steps: ReadonlyArray<PlanStep> } | null;
  readonly agents: ReadonlyArray<AgentRow & { readonly turnId: string | null }>;
  readonly context: ContextUsage | null;
  readonly costUsd: number | null;
}

/**
 * Only Claude reports a cost, and its `total_cost_usd` is a running total of the session, not the
 * turn's own. Any other driver's meaning is unknown, so its cost is left out rather than guessed.
 */
const CUMULATIVE_COST_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

interface CostReport {
  readonly session: string;
  readonly cost: number;
}

/**
 * The spend behind running totals, in the order they were reported: each report adds what the
 * session's total grew by, and a total that went down is a new session starting over. A zero
 * carries no information and must not make the next total look like new spend.
 */
// Reports carry no session id, so a new session whose total passes the old one's is read as growth
// and the shown cost comes out low; it never comes out high.
const sumRunningTotals = (reports: ReadonlyArray<CostReport>): number | null => {
  const last = new Map<string, number>();
  let total = 0;
  let any = false;
  for (const { session, cost } of reports) {
    if (cost <= 0) continue;
    const before = last.get(session) ?? 0;
    total += cost >= before ? cost - before : cost;
    last.set(session, cost);
    any = true;
  }
  return any ? total : null;
};

const planStepsOf = (payload: Record<string, unknown>): ReadonlyArray<PlanStep> => {
  const raw = Array.isArray(payload.plan) ? (payload.plan as ReadonlyArray<unknown>) : [];
  return raw.flatMap((entry): PlanStep[] => {
    const record = recordOf(entry);
    const step = textOf(record.step);
    if (step === null) return [];
    const status =
      record.status === "completed" || record.status === "inProgress" ? record.status : "pending";
    return [{ step, status }];
  });
};

/**
 * Everything the status bar and the live region read from the activity list, in one pass. A task
 * counts as a sub-agent only when the server stamped it `agentKind: "agent"`; shells and monitors
 * are background work and stay out. Server clocks are trusted for ordering only.
 */
const foldActivities = (activities: ReadonlyArray<OrchestrationThreadActivity>): ActivityFacts => {
  const agents = new Map<string, AgentRow & { turnId: string | null }>();
  const settled = new Set<string>();
  let plan: ActivityFacts["plan"] = null;
  let context: ContextUsage | null = null;
  const costs = new Map<string, CostReport>();

  const end = (taskId: string) => {
    agents.delete(taskId);
    settled.add(taskId);
  };

  for (const activity of activities) {
    const payload = recordOf(activity.payload);
    const turnId = activity.turnId ?? null;
    switch (activity.kind) {
      case "turn.plan.updated": {
        const steps = planStepsOf(payload);
        plan = steps.length === 0 ? null : { turnId, steps };
        break;
      }
      case "context-window.updated": {
        const used = numberOf(payload.usedTokens);
        if (used === null || used < 0) break;
        const max = numberOf(payload.maxTokens);
        context = {
          usedTokens: used,
          maxTokens: max !== null && max > 0 ? max : null,
          percent: max !== null && max > 0 ? Math.min(100, (used / max) * 100) : null,
        };
        break;
      }
      case OWNED_USAGE_ACTIVITY_KIND: {
        const cost = numberOf(payload.costUsd);
        const source = recordOf(payload.source);
        const driver = textOf(source.driver);
        if (
          cost !== null &&
          cost >= 0 &&
          payload.scope === "main-turn" &&
          driver !== null &&
          CUMULATIVE_COST_DRIVERS.has(driver)
        ) {
          const session = `${driver}:${textOf(source.instanceId) ?? ""}`;
          costs.set(textOf(source.runtimeEventId) ?? activity.id, { session, cost });
        }
        break;
      }
      case "task.started": {
        const taskId = textOf(payload.taskId);
        if (taskId === null || payload.agentKind !== "agent" || settled.has(taskId)) break;
        const startedAt = Date.parse(activity.createdAt);
        agents.set(taskId, {
          id: taskId,
          name: textOf(payload.title) ?? textOf(payload.detail) ?? taskId,
          work: null,
          startedAt: Number.isNaN(startedAt) ? null : startedAt,
          turnId,
        });
        break;
      }
      case "task.progress": {
        const taskId = textOf(payload.taskId);
        const known = taskId === null ? undefined : agents.get(taskId);
        if (taskId === null || known === undefined) break;
        const status = textOf(payload.status);
        if (status !== null && TERMINAL_TASK_STATUSES.has(status)) {
          end(taskId);
          break;
        }
        if (payload.usageSnapshot === true) break;
        const work = textOf(payload.lastToolName) ?? textOf(payload.summary);
        if (work !== null) agents.set(taskId, { ...known, work: firstLineOf(work) });
        break;
      }
      case "tool.progress": {
        const taskId = textOf(payload.taskId);
        const known = taskId === null ? undefined : agents.get(taskId);
        const tool = textOf(payload.toolName);
        if (taskId !== null && known !== undefined && tool !== null) {
          agents.set(taskId, { ...known, work: tool });
        }
        break;
      }
      case "task.updated": {
        const taskId = textOf(payload.taskId);
        if (taskId === null || !agents.has(taskId)) break;
        const status = textOf(payload.status);
        if (
          payload.endedAt !== undefined ||
          (status !== null && TERMINAL_TASK_STATUSES.has(status))
        ) {
          end(taskId);
        }
        break;
      }
      case "task.completed": {
        const taskId = textOf(payload.taskId);
        if (taskId !== null) end(taskId);
        break;
      }
      default:
        break;
    }
  }
  return {
    plan,
    agents: [...agents.values()],
    context,
    costUsd: sumRunningTotals([...costs.values()]),
  };
};

const factsCache = new WeakMap<ReadonlyArray<OrchestrationThreadActivity>, ActivityFacts>();

/** Like the pending requests, these only change with the activity list, so message deltas reuse them. */
const factsFor = (activities: ReadonlyArray<OrchestrationThreadActivity>): ActivityFacts => {
  const cached = factsCache.get(activities);
  if (cached !== undefined) return cached;
  const derived = foldActivities(activities);
  factsCache.set(activities, derived);
  return derived;
};

const pendingCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReturnType<typeof derivePendingRequests>
>();

/** Pending requests only change with the activity list, so message deltas reuse the last result. */
const pendingFor = (activities: ReadonlyArray<OrchestrationThreadActivity>) => {
  const cached = pendingCache.get(activities);
  if (cached !== undefined) return cached;
  const derived = derivePendingRequests(activities);
  pendingCache.set(activities, derived);
  return derived;
};

export const deriveThreadStatus = (thread: OrchestrationThread): ThreadStatus => {
  const pending = pendingFor(thread.activities);
  const sessionStatus = thread.session?.status ?? "idle";
  const running =
    sessionStatus === "running" ||
    sessionStatus === "starting" ||
    thread.latestTurn?.state === "running";
  const lastError = thread.session?.status === "error" ? (thread.session.lastError ?? null) : null;

  let phase: ThreadPhase = "idle";
  if (pending.approvals.length > 0) phase = "approval";
  else if (pending.userInputs.length > 0) phase = "input";
  else if (running) phase = "working";
  else if (lastError !== null) phase = "error";

  // The turn the server says is running. While a follow-up turn is still starting there is none yet
  // and `latestTurn` is the previous, finished turn, so nothing of it may be shown as current.
  const latestTurn = thread.latestTurn;
  const activeTurnId =
    thread.session?.activeTurnId ?? (latestTurn?.state === "running" ? latestTurn.turnId : null);
  const currentTurnId = running ? activeTurnId : null;
  const tool = currentTurnId === null ? null : findRunningTool(thread.activities, currentTurnId);
  const facts = factsFor(thread.activities);
  // Plan and sub-agents belong to the turn that is running; they go away with it.
  const ofThisTurn = (owner: string | null) =>
    currentTurnId !== null && (owner === null || owner === currentTurnId);
  const startedAt =
    currentTurnId !== null && latestTurn?.turnId === currentTurnId
      ? Date.parse(latestTurn.startedAt ?? "")
      : Number.NaN;

  return {
    phase,
    interruptible: running,
    runningTool: tool?.title ?? null,
    runningToolDetail: tool?.detail ?? null,
    pending,
    lastError,
    turnStartedAt: Number.isNaN(startedAt) ? null : startedAt,
    plan: facts.plan !== null && ofThisTurn(facts.plan.turnId) ? facts.plan.steps : [],
    agents: facts.agents.filter((agent) => ofThisTurn(agent.turnId)),
    context: facts.context,
    costUsd: facts.costUsd,
  };
};
