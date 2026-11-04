// @effect-diagnostics nodeBuiltinImport:off
import {
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionUpdate,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  type TaskRunHandles,
  ThreadId,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import { type ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { encodeUnknownJsonStringExit } from "./ClaudeAdapter.history.ts";
import { type PlanStep } from "./ClaudeAdapter.tasks.ts";
import { type ClaudeRouteProfileSeed } from "./ClaudeAdapter.prompt.ts";

export const PROVIDER = ProviderDriverKind.make("claudeAgent");

export type ClaudeTextStreamKind = Extract<
  RuntimeContentStreamKind,
  "assistant_text" | "reasoning_text" | "reasoning_summary_text"
>;

export type ClaudeToolResultStreamKind = Extract<
  RuntimeContentStreamKind,
  "command_output" | "file_change_output"
>;

export type ClaudeSdkEffort = NonNullable<ClaudeQueryOptions["effort"]>;

export function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

export type PromptQueueItem =
  | {
      readonly type: "message";
      readonly message: SDKUserMessage;
    }
  | {
      readonly type: "terminate";
    };

/** What sendTurn's synchronous admission step decided. */
export type TurnAdmission =
  | { readonly _tag: "Closed" }
  | { readonly _tag: "AwaitCompletion"; readonly completion: Deferred.Deferred<void> }
  | { readonly _tag: "CloseSynthetic" }
  | { readonly _tag: "Admitted"; readonly turnId: TurnId; readonly resumeCursor: unknown };

export interface ClaudeResumeState {
  readonly threadId?: ThreadId;
  readonly resume?: string;
  readonly resumeSessionAt?: string;
  readonly turnCount?: number;
  readonly turnStartMessageIds?: ReadonlyArray<string | null>;
}

export interface ClaudeTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  /**
   * True for turns auto-started by assistant output arriving without an
   * active turn (background agent/subagent responses between user prompts).
   * Synthetic turns are auto-closed by the next sendTurn; real turns are
   * steered instead (the queued message continues the same turn).
   */
  readonly synthetic?: boolean;
  /** The result this turn's completion was given. Whichever fiber publishes the turn takes its metadata for the one turn.completed. */
  joinedResult?: SDKResultMessage;
  readonly assistantTextBlocks: Map<number, AssistantTextBlockState>;
  readonly assistantTextBlockOrder: Array<AssistantTextBlockState>;
  readonly capturedProposedPlanKeys: Set<string>;
  latestAssistantUsage: unknown | undefined;
  compactedSinceLatestAssistantUsage: boolean;
  hasSubagents: boolean;
  /**
   * Agent tasks the lead started in this turn. While one still runs, a success
   * result does not end the turn: the SDK continues it once they report, and
   * the result of that continuation completes it.
   */
  readonly backgroundAgentTaskIds: Set<string>;
  /** Success results that arrived while those agents ran; their usage counts toward the turn. */
  readonly heldResults: Array<SDKResultMessage>;
  nextSyntheticAssistantBlockIndex: number;
  authenticationFailureMessage: string | undefined;
  rejectedRateLimitTypes: Set<string>;
  latestAssistantRateLimited: boolean;
  emittedThinkingText: boolean;
  readonly thinkingSnapshotIds: Set<string>;
}

export interface AssistantTextBlockState {
  readonly itemId: string;
  readonly blockIndex: number;
  emittedTextDelta: boolean;
  fallbackText: string;
  streamClosed: boolean;
  completionEmitted: boolean;
}

export interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly suggestions?: ReadonlyArray<PermissionUpdate>;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

/**
 * Permission updates applied for an "Always allow this session" decision.
 *
 * Claude Code's suggestions are reused when present but rescoped to
 * `destination: "session"` — echoing them verbatim would persist the
 * session-only choice as a permanent rule (suggestions typically target
 * `localSettings`, i.e. `.claude/settings.local.json`). When Claude Code
 * offers no suggestion — common for MCP tools — fall back to a whole-tool
 * session allow rule so the decision still sticks for the session instead of
 * silently degrading into a one-shot accept.
 */
export function toSessionPermissionUpdates(
  toolName: string,
  suggestions: ReadonlyArray<PermissionUpdate> | undefined,
): Array<PermissionUpdate> {
  const sessionScoped = (suggestions ?? []).map((suggestion): PermissionUpdate => ({
    ...suggestion,
    destination: "session",
  }));
  if (sessionScoped.length > 0) {
    return sessionScoped;
  }
  return [
    {
      type: "addRules",
      rules: [{ toolName }],
      behavior: "allow",
      destination: "session",
    },
  ];
}

export interface PendingUserInput {
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly answers: Deferred.Deferred<ProviderUserInputAnswers>;
  /** Unparks the waiting handler as cancelled. Session teardown must run it. */
  readonly cancel: Effect.Effect<void>;
}

export interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
  readonly partialInputJson: string;
  readonly lastEmittedInputFingerprint?: string;
  /** Owning agent when this tool ran inside a subagent (see attribution note). */
  readonly agentId?: string;
  readonly parentToolUseId?: string;
}

export interface ClaudeTaskState {
  readonly id: string;
  subject: string;
  status: PlanStep["status"];
  readonly blockedBy: Set<string>;
}

/**
 * Agent identity captured from task_started and repeated on every subsequent
 * task.* payload, so client folds can reconstruct an agent even when its
 * start row aged out of activity retention.
 */
export interface ClaudeTaskAgentState {
  readonly taskId: string;
  toolUseId: string | undefined;
  description: string | undefined;
  subagentType: string | undefined;
  taskType: string | undefined;
  workflowName: string | undefined;
  skipTranscript: boolean;
  runHandles: TaskRunHandles | undefined;
  /** Set when this task was launched from inside a subagent. */
  owningAgentId: string | undefined;
  /** Seeded from the launching tool's input; refined by the subagent's own
   * assistant snapshots (authoritative API model). */
  model: string | undefined;
  effort: string | undefined;
}

/**
 * How many racing snapshot models to buffer per session. A snapshot whose
 * task_started never arrives would otherwise pin its entry for the session's
 * lifetime; oldest entries evict first.
 */
export const PENDING_TASK_MODEL_CAP = 64;

/** How long Stop waits for Claude to abort a turn before killing the process. */
export const CLAUDE_INTERRUPT_GRACE = "3 seconds";

/**
 * Buffers a subagent snapshot's authoritative model under its
 * parent_tool_use_id, for snapshots that beat their task_started to the
 * stream. task_started consumes the entry when it registers the task.
 */
export function rememberPendingTaskModel(
  pending: Map<string, string>,
  parentToolUseId: string,
  model: string,
): void {
  pending.set(parentToolUseId, model);
  if (pending.size > PENDING_TASK_MODEL_CAP) {
    const oldest = pending.keys().next();
    if (!oldest.done) {
      pending.delete(oldest.value);
    }
  }
}

export interface ClaudeSessionContext {
  session: ProviderSession;
  startInput: Parameters<ClaudeAdapterShape["startSession"]>[0];
  readonly turnStartMessageIds: Array<string | null>;
  readonly promptQueue: Queue.Queue<PromptQueueItem>;
  readonly query: ClaudeQueryRuntime;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  readonly basePermissionMode: PermissionMode | undefined;
  /** The mode the session actually runs under now — the launch mode until a
   * successful in-session setter moves it, then retained when a send carries
   * no interactionMode. Tracked like currentApiModelId so the publish-time
   * route profile reports the real post-setter value. */
  currentPermissionMode: PermissionMode | undefined;
  currentApiModelId: string | undefined;
  /** Effective effort for the session's turns; subagents without an explicit
   * effort override inherit this. */
  currentEffort: string | undefined;
  resumeSessionId: string | undefined;
  /**
   * The launch-fixed half of the observed route profile hashed into every
   * admission's submissionCandidate — snapshotted from the constructed query
   * options and settings at session start. Undefined when launch args make
   * the route unprovable; capture stays off then while sends are unchanged.
   */
  readonly routeProfileSeed: ClaudeRouteProfileSeed | undefined;
  /**
   * Identity version reported to the sendTurn admission gate: allocated at
   * context creation and bumped again whenever the SDK moves the durable
   * session id, so an observation captured before either change can never
   * match the context that actually publishes.
   */
  generation: number;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<ApprovalRequestId, PendingUserInput>;
  /** Completed turn ids, reported by readThread and trimmed on rollback.
   * SDK messages are not kept: rollback reads Claude's own history through
   * turnStartMessageIds, and a long-lived session would otherwise hold every
   * message it ever produced. */
  readonly turns: Array<{ readonly id: TurnId }>;
  readonly inFlightTools: Map<number, ToolInFlight>;
  readonly claudeTasks: Map<string, ClaudeTaskState>;
  readonly taskAgents: Map<string, ClaudeTaskAgentState>;
  /**
   * Authoritative subagent models from assistant snapshots that arrived before
   * their task_started registered the task, keyed by parent_tool_use_id.
   * Written through `rememberPendingTaskModel`, consumed by task_started.
   */
  readonly pendingTaskModels: Map<string, string>;
  /**
   * Last emitted workflow-member fingerprint per member slot. A coordinator
   * task_progress repeats the FULL member array every tick; without a
   * material-transition filter one provider tick fans out into up to 100
   * runtime events (event-log writes, queue pressure, client reducer work)
   * even when nothing changed for most members.
   */
  readonly workflowMemberFingerprints: Map<string, string>;
  /** Task ids that have started and not yet reached a terminal state. */
  readonly liveTaskIds: Set<string>;
  turnState: ClaudeTurnState | undefined;
  lastKnownContextWindow: number | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  lastKnownTotalProcessedTokens: number | undefined;
  lastAssistantUuid: string | undefined;
  lastThreadStartedId: string | undefined;
  /** Limits already announced for the running turn, keyed `window:resetsAt`. */
  announcedUsageLimits: { turnId: string; keys: Set<string> } | undefined;
  /** Resolved by completeTurn while Stop waits for Claude to abort the turn. */
  interruptedTurnSettled: Deferred.Deferred<void> | undefined;
  /** Settled when the running completeTurn ends; a send waits on it instead of steering. */
  completing: Deferred.Deferred<void> | undefined;
  /**
   * Serializes sendTurn setup and admission so overlapping sends cannot
   * interleave. Never held for a provider turn's lifetime, and never taken by
   * stop, interrupt, completeTurn or the stream handlers.
   */
  readonly sendTurnLock: Semaphore.Semaphore;
  /** Completed by stop so a send parked on the SDK or the lock fails instead. */
  readonly closed: Deferred.Deferred<void>;
  stopped: boolean;
}

export interface ClaudeQueryRuntime extends AsyncIterable<SDKMessage> {
  /** SDK Query.interrupt — present on real queries; optional for test doubles. */
  readonly interrupt?: () => Promise<unknown>;
  readonly setModel: (model?: string) => Promise<void>;
  readonly setPermissionMode: (mode: PermissionMode) => Promise<void>;
  readonly setMaxThinkingTokens: (maxThinkingTokens: number | null) => Promise<void>;
  readonly close: () => void;
}
