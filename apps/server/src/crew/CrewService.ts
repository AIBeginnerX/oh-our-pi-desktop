/**
 * CrewService - runs OOP Crew for a thread.
 *
 * The thread's own model is the brain. It hands a task to the worker or expert model through the
 * crew MCP tools; each task runs as its own thread in the same workspace, and its start and finish
 * are appended to the lead thread as task activities so the Agents panel and the workflow board
 * draw them live. When a lead turn changes files, the auditor model reviews it the same way.
 *
 * @module CrewService
 */
import {
  CommandId,
  EventId,
  MessageId,
  OWNED_USAGE_ACTIVITY_KIND,
  ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
  CREW_STOPPED_ACTIVITY,
  CREW_STOPPING_ACTIVITY,
  crewTaskProgressActivityId,
  type CrewRole,
  type CrewTodoStatus,
  type ModelSelection,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ServerProvider,
  type ServerProviderUsageWindow,
  ThreadTurnDiffCompletedPayload,
  type TurnId,
} from "@t3tools/contracts";
import {
  canLeadCrew,
  crewFallbackChain,
  crewModelOptions,
  resolveCrew,
  type CrewModelOption,
  type ResolvedCrew,
} from "@t3tools/shared/crew";
import { resolveProjectMemoryReferences } from "@t3tools/shared/composerContextReferences";
import {
  CREW_AUDIT_SKIPPED_ACTIVITY,
  CREW_RESULTS_DROPPED_ACTIVITY,
} from "@t3tools/shared/threadGoal";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProjectMemorySendGate from "../memory/ProjectMemorySendGate.ts";
import { ProviderCapacity } from "../provider/Services/ProviderCapacity.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CrewRuntimeStateLive from "../persistence/Layers/CrewRuntimeState.ts";
import { CrewRuntimeState } from "../persistence/Services/CrewRuntimeState.ts";
import type { CrewFollowUpCheckpoint } from "../persistence/Services/CrewRuntimeState.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import * as ProcessRunner from "../processRunner.ts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "../orphanedProviderSession.ts";
import { CrewFollowUpRecoveryJson } from "./crewRecoveryState.ts";
import {
  makeCrewTodoChecks,
  TODO_COMMAND_TIMEOUT,
  type TodoCommandResult,
} from "./crewTodoChecks.ts";
import { nudgeText, proofLabel, taskProof, type TaskProof } from "./crewTodos.ts";
import {
  addedTodosText,
  appendTodos,
  assignTodos,
  CREW_TODO_MAX,
  filesOutsideScope,
  judgeFilesCheck,
  openTodoIds,
  resetTodos,
  summarizeOutOfScope,
  todoCounts,
  todoResumeLines,
  type TodoInput,
  type TodoItem,
} from "./crewTodos.ts";
import {
  candidateNote,
  makeCrewWorktrees,
  mergeConflictNote,
  type CrewWorktree,
} from "./crewWorktree.ts";
import { crewThreadUsage } from "./crewUsage.ts";
import {
  CREW_MAX_FIX_ROUNDS,
  CREW_MAX_FOLLOW_UPS,
  CREW_ROLE_LABEL,
  AUDIT_DIFF_MAX_CHARS,
  auditDiff,
  auditPrompt,
  auditVerdict,
  clipCrewReport,
  clipLeadReport,
  crewMemberOutcome,
  withTodoOutcome,
  followUpRound,
  isCrewFollowUp,
  planFollowUp,
  crewTaskStatus,
  crewExhaustedReport,
  crewLimitWindowName,
  crewThreadTitle,
  delegatePrompt,
  withCrewMemoryReferences,
  withoutCrewMemoryReferences,
  type CrewMemoryRef,
  isCrewThreadTitle,
  isSettledCrewStatus,
  overlappingWriteScopes,
  previousAttemptOf,
  type PriorCrewTask,
  repeatTaskWarning,
  reportExcerpt,
  latestAuditAsksChanges,
  lightAuditPrompt,
  planTurnAudit,
  turnChangedLines,
  turnRanPassingTests,
  writeScopeWarning,
  type CrewMemberReport,
  type CrewTaskOutcome,
  type CrewTaskStatus,
  crewFailureKind,
  CANDIDATE_CHECKOUT_PROMPT,
  ISOLATED_CHECKOUT_PROMPT,
} from "./crewLogic.ts";
import {
  WAIT_COLLECT_SECONDS,
  waitBounds,
  RESULT_TEXT_LIMIT,
  NUDGE_IDLE_WAIT_SECONDS,
  CREW_LEAD_REFUSAL,
  STOP_WAIT_SECONDS,
  STOPPED_WITH_LEAD,
  STOPPED_ON_REQUEST,
  DELETED_LEAD,
  FAILED_PROVIDER_COOLDOWN_MS,
  LIMIT_COOLDOWN_MS,
  REPEAT_REFUSAL_BLOCK_MS,
  type AvoidedTask,
  type CrewAttempt,
  type CrewTaskRecord,
  lastRunThreadId,
  MEMORY_HOLD_DETAILS,
  STOPPED_START_DETAILS,
  STATUS_EVENTS,
  proofLine,
  todoPayload,
  todoNoteOf,
  withNote,
  familyOf,
  cleanWhy,
  encodeTaskRecovery,
  decodeTaskRecovery,
  encodeFollowUpRecovery,
  decodeFollowUpRecovery,
} from "./crewTaskRecord.ts";

export class CrewError extends Schema.TaggedError<CrewError>()("CrewError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return this.reason;
  }
}

export interface CrewRosterEntry {
  readonly role: CrewRole;
  readonly model: string | null;
  readonly provider: string | null;
  /** The user's fallback models for the role, in the order they are tried; absent when none. */
  readonly fallbacks?: ReadonlyArray<{ readonly model: string; readonly provider: string }>;
}

/** One cooling entry as crew_roster shows it: a provider, or one model its provider refused. */
export interface CrewCoolingEntry {
  readonly provider: string;
  readonly model?: string | undefined;
  /** When the cooling ends; absent when it ends when the provider is checked again. */
  readonly until?: string | undefined;
  readonly reason: string;
}

export interface CrewTaskReport {
  readonly taskId: string;
  readonly role: CrewRole | null;
  readonly status: CrewTaskOutcome;
  readonly result: string | null;
  /** The crew member's JSON report, when its reply ended with one that decodes. */
  readonly report?: CrewMemberReport | undefined;
  /** Whether OOP itself could verify the work; set for a finished worker or expert task. */
  readonly proof?: TaskProof | undefined;
}

export interface CrewTodoCheckResult {
  readonly todoId: string;
  readonly status: CrewTodoStatus;
  /** The item was already settled, so nothing ran this time. */
  readonly alreadyChecked: boolean;
  /** Ids of the items that still need work: pending, or done but failing. */
  readonly remaining: ReadonlyArray<string>;
  /** Why the item is not verified, when it is not. */
  readonly message?: string | undefined;
  /** The end of a failed command's output. */
  readonly output?: string | undefined;
}

export class CrewService extends Context.Service<
  CrewService,
  {
    readonly roster: (threadId: ThreadId) => Effect.Effect<
      {
        readonly enabled: boolean;
        readonly roles: CrewRosterEntry[];
        /** Providers and single models cooling down right now; empty when none. */
        readonly cooling: CrewCoolingEntry[];
      },
      CrewError
    >;
    readonly delegate: (input: {
      readonly threadId: ThreadId;
      readonly role: "worker" | "expert";
      readonly task: string;
      readonly title?: string | undefined;
      readonly writeScope?: ReadonlyArray<string> | undefined;
      readonly verify?: string | undefined;
      readonly doneWhen?: string | undefined;
      /** "worktree" runs the task in its own git worktree and applies its changes back. */
      readonly isolation?: "shared" | "worktree" | "candidate" | undefined;
      /** "small" runs the task on the fast model, unless the user pinned the role's model. */
      readonly size?: "small" | "normal" | undefined;
      /** Task ids whose model family this task must not share, when another family is available. */
      readonly differentFrom?: ReadonlyArray<string> | undefined;
      /** The task's checklist; the server numbers the items and tracks them. */
      readonly todos?: ReadonlyArray<TodoInput> | undefined;
      /** Why the lead chose this; goes into the `task.started` activity only. */
      readonly why?: string | undefined;
    }) => Effect.Effect<
      {
        readonly taskId: string;
        readonly model: string;
        readonly warning?: string | undefined;
        /** The items with the ids the server gave them; absent without a checklist. */
        readonly todos?: ReadonlyArray<{ readonly id: string; readonly text: string }> | undefined;
      },
      CrewError
    >;
    /**
     * A crew member marks one item of its own task's checklist. An item with a server check is
     * verified only when the server runs that check and it passes.
     */
    readonly checkTodo: (input: {
      readonly threadId: ThreadId;
      readonly todoId: string;
      readonly status: "done" | "blocked";
      readonly note?: string | undefined;
    }) => Effect.Effect<CrewTodoCheckResult, CrewError>;
    /**
     * The lead adds items to its own task that is still running. They join the list at once and
     * reach the member as a follow-up turn when its current turn ends.
     */
    readonly addTodos: (input: {
      readonly threadId: ThreadId;
      readonly taskId: string;
      readonly todos: ReadonlyArray<TodoInput>;
    }) => Effect.Effect<
      {
        readonly todos: ReadonlyArray<{ readonly id: string; readonly text: string }>;
        readonly total: number;
      },
      CrewError
    >;
    /** Runs a worker or expert task that ended without finishing again, as a new task. */
    readonly retryTask: (input: {
      readonly threadId: ThreadId;
      readonly taskId: string;
    }) => Effect.Effect<{ readonly taskId: string; readonly model: string }, CrewError>;
    /**
     * Stops the lead's running tasks, one by `taskId` or all of them: each member's turn is
     * interrupted, and the task ends stopped without being retried on another model. Returns the
     * tasks that ended stopped once they have; a task still winding down when the wait runs out
     * is listed in `stopping` instead, and the lead's `crew.stopped` activity is not appended.
     */
    readonly stop: (input: {
      readonly threadId: ThreadId;
      readonly taskId?: string | undefined;
      /** Why the lead stops; goes into the `crew.stopped` / `crew.stopping` activity. */
      readonly why?: string | undefined;
    }) => Effect.Effect<
      { readonly stopped: ReadonlyArray<string>; readonly stopping: ReadonlyArray<string> },
      CrewError
    >;
    readonly wait: (input: {
      readonly threadId: ThreadId;
      readonly taskIds: ReadonlyArray<string>;
      readonly timeoutSeconds?: number | undefined;
      /**
       * The provider instance whose MCP client made the call. A client whose tool-call timeout
       * OOP sets itself (claudeAgent) may wait past the unknown-client cap; without this, the
       * 50 second cap holds.
       */
      readonly providerInstanceId?: ProviderInstanceId | undefined;
    }) => Effect.Effect<ReadonlyArray<CrewTaskReport>, CrewError>;
  }
>()("t3/crew/CrewService") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  // Optional so focused crew tests need not build the capacity layer; production always has it.
  const capacity = yield* Effect.serviceOption(ProviderCapacity);
  const memoryGate = yield* ProjectMemorySendGate.ProjectMemorySendGate;
  const settings = yield* ServerSettings.ServerSettingsService;
  const checkpointDiffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const crypto = yield* Crypto.Crypto;
  const recovery = yield* CrewRuntimeState;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const turns = yield* ProjectionTurnRepository;
  const worktrees = yield* makeCrewWorktrees;
  const todoChecks = yield* makeCrewTodoChecks;

  // Watchers outlive the tool call that started them, so they run in the service's own scope.
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const tasks = new Map<string, CrewTaskRecord>();
  /** Threads that lead at least one task; only these can have a delivery waiting. */
  const leadIds = new Set<ThreadId>();
  const auditedTurns = new Set<string>();
  /** The reason of the latest stop of a whole lead; a task created across it starts stopped. */
  const leadStops = new Map<ThreadId, { readonly count: number; readonly reason: string }>();
  /**
   * The last lead turn the user stopped, per lead; its changes are not sent to an audit and its
   * late tool calls start nothing. A later stop replaces it and only a delete drops it, so it is
   * bounded by the lead count and no gap opens between the next turn being requested and started.
   */
  const stoppedLeadTurns = new Map<ThreadId, TurnId>();
  const isStoppedLeadTurn = (leadId: ThreadId, turnId: TurnId) =>
    stoppedLeadTurns.get(leadId) === turnId;
  /** Drops the stop marks and counter of a deleted lead. */
  const forgetLeadStops = (leadId: ThreadId) => {
    stoppedLeadTurns.delete(leadId);
    leadStops.delete(leadId);
  };
  const followUpLock = yield* Semaphore.make(1);
  const failedProviders = new Map<string, number>();
  // A billing or sign-in failure lasts until the provider's status is checked again (the
  // provider's checkedAt then passes the one recorded here); a cooldown would only retry it.
  const blockedProviders = new Map<
    string,
    { readonly checkedAt: string; readonly reason: string }
  >();
  /**
   * Full usage windows a limit cooling waits on. A newer usage check that shows none of them
   * full any more (the user reset the limit, or redeemed a reset credit) ends the cooling early.
   */
  interface FullWindows {
    readonly ids: ReadonlyArray<string>;
    readonly checkedAt: string;
  }
  // A usage limit cools the whole provider until its full windows reset; without such a window,
  // for a short while, so the next attempt probes it again soon.
  const limitedProviders = new Map<
    string,
    { readonly until: number; readonly reason: string; readonly windows?: FullWindows }
  >();
  // A provider that refused one model, or whose window for that one model is full, works fine for
  // its others: only that model is blocked. A refusal lasts until the provider's status is checked
  // again, like a billing or sign-in failure, and a second one for a day; a full model window,
  // until it resets.
  const blockedModels = new Map<
    string,
    Map<
      string,
      {
        readonly selection: ModelSelection;
        readonly checkedAt: string;
        readonly reason: string;
        readonly until?: number;
        readonly windows?: FullWindows;
      }
    >
  >();

  /** Refusals per model (`modelKey`) since it last worked; a second one blocks it for a day. */
  const refusals = new Map<string, number>();

  /** A provider (or one model on it) that new tasks skip for now. */
  interface Cooling {
    readonly providers: ReadonlySet<string>;
    readonly models: ReadonlyArray<ModelSelection>;
    /** The same cooling as crew_roster shows it: one entry per provider, and per blocked model. */
    readonly entries: ReadonlyArray<CrewCoolingEntry>;
    /** The switch-message phrase per cooling provider, for the task progress summary. */
    readonly notes: ReadonlyMap<string, string>;
    /** The switch-message phrase per blocked model, keyed by `modelKey`. */
    readonly modelNotes: ReadonlyMap<string, string>;
  }
  const modelKey = (selection: ModelSelection) => `${selection.instanceId}\u0000${selection.model}`;
  const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));
  /** Whether a newer usage check shows none of the windows a cooling waits on full any more. */
  const windowsCleared = (
    provider: ServerProvider | undefined,
    windows: FullWindows | undefined,
  ) => {
    const usage = provider?.usageLimits;
    // A failed usage check reports no windows; that says nothing about the full ones.
    if (
      windows === undefined ||
      usage === undefined ||
      usage.unavailable !== undefined ||
      usage.checkedAt <= windows.checkedAt
    )
      return false;
    return !usage.windows.some(
      (window) => windows.ids.includes(window.id) && window.usedPercent >= 100,
    );
  };

  const cooling = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [instanceId, until] of failedProviders) {
      if (until <= now) failedProviders.delete(instanceId);
    }
    if (
      failedProviders.size + limitedProviders.size + blockedProviders.size + blockedModels.size ===
      0
    ) {
      return {
        providers: new Set<string>(),
        models: [] as ReadonlyArray<ModelSelection>,
        entries: [] as ReadonlyArray<CrewCoolingEntry>,
        notes: new Map<string, string>(),
        modelNotes: new Map<string, string>(),
      } satisfies Cooling;
    }
    const snapshot = yield* providers.getProviders;
    const providerOf = (instanceId: string) =>
      snapshot.find((entry) => entry.instanceId === instanceId);
    for (const [instanceId, cooled] of limitedProviders) {
      if (cooled.until <= now || windowsCleared(providerOf(instanceId), cooled.windows)) {
        limitedProviders.delete(instanceId);
      }
    }
    for (const [instanceId, blocked] of blockedProviders) {
      const provider = providerOf(instanceId);
      if (provider === undefined || provider.checkedAt > blocked.checkedAt) {
        blockedProviders.delete(instanceId);
      }
    }
    for (const [instanceId, models] of blockedModels) {
      const provider = providerOf(instanceId);
      for (const [model, blocked] of models) {
        const ended =
          provider === undefined ||
          (blocked.until === undefined
            ? provider.checkedAt > blocked.checkedAt
            : blocked.until <= now || windowsCleared(provider, blocked.windows));
        if (ended) models.delete(model);
      }
      if (models.size === 0) blockedModels.delete(instanceId);
    }
    const labelOf = (instanceId: string) => providerOf(instanceId)?.displayName ?? instanceId;
    /** What the switch message says about a cooling that ends at `until`. */
    const span = (until: number | undefined, probing: boolean) =>
      until === undefined
        ? ""
        : probing
          ? ` for ${Math.max(1, Math.ceil((until - now) / 60_000))} more minutes`
          : ` until ${isoOf(until)}`;
    const entries: CrewCoolingEntry[] = [];
    const notes = new Map<string, string>();
    const providerIds = new Set<string>([
      ...failedProviders.keys(),
      ...limitedProviders.keys(),
      ...blockedProviders.keys(),
    ]);
    // One entry per provider: a block that waits on a status check outlasts any timed one, and
    // of two timed ones the later end is the one that holds.
    for (const instanceId of providerIds) {
      const blocked = blockedProviders.get(instanceId);
      const limited = limitedProviders.get(instanceId);
      const failed = failedProviders.get(instanceId);
      const shown =
        blocked !== undefined
          ? { reason: blocked.reason, until: undefined, probing: false }
          : limited !== undefined && (failed === undefined || limited.until >= failed)
            ? {
                reason: limited.reason,
                until: limited.until,
                probing: limited.windows === undefined,
              }
            : { reason: "failed", until: failed, probing: false };
      const provider = labelOf(instanceId);
      entries.push({
        provider,
        ...(shown.until === undefined ? {} : { until: isoOf(shown.until) }),
        reason: shown.reason,
      });
      notes.set(
        instanceId,
        `cooling ${provider}${span(shown.until, shown.probing)} (${shown.reason})`,
      );
    }
    const models: ModelSelection[] = [];
    const modelNotes = new Map<string, string>();
    for (const modelsOfProvider of blockedModels.values()) {
      for (const blocked of modelsOfProvider.values()) {
        const provider = labelOf(blocked.selection.instanceId);
        models.push(blocked.selection);
        entries.push({
          provider,
          model: blocked.selection.model,
          ...(blocked.until === undefined ? {} : { until: isoOf(blocked.until) }),
          reason: blocked.reason,
        });
        modelNotes.set(
          modelKey(blocked.selection),
          blocked.until === undefined
            ? `${blocked.selection.model} is refused by ${provider}; skipping it until the provider is checked again`
            : `skipping ${blocked.selection.model} on ${provider}${span(blocked.until, false)} (${blocked.reason})`,
        );
      }
    }
    return { providers: providerIds, models, entries, notes, modelNotes } satisfies Cooling;
  });

  /**
   * Which full usage windows a limit on this model waits on: the account's own windows, and those
   * that name this model's family (`modelFamilies`, matched against the words of its id). A window
   * for another family, or for a tool, holds back nothing here.
   */
  const fullWindowsFor = (
    provider: ServerProvider | undefined,
    model: string,
    now: number,
  ): {
    readonly provider: ServerProviderUsageWindow[];
    readonly model: ServerProviderUsageWindow[];
  } => {
    const wordsOf = (text: string) =>
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
    const words = new Set(wordsOf(model));
    const result = {
      provider: [] as ServerProviderUsageWindow[],
      model: [] as ServerProviderUsageWindow[],
    };
    for (const window of provider?.usageLimits?.windows ?? []) {
      if (window.usedPercent < 100 || window.resetsAt === undefined) continue;
      if (Date.parse(window.resetsAt) <= now) continue;
      if (window.modelFamilies === undefined) result.provider.push(window);
      else if (window.modelFamilies.some((family) => words.has(wordsOf(family)[0] ?? "")))
        result.model.push(window);
    }
    return result;
  };
  const latestReset = (windows: ReadonlyArray<ServerProviderUsageWindow>) =>
    windows.reduce((latest, window) =>
      Date.parse(window.resetsAt!) > Date.parse(latest.resetsAt!) ? window : latest,
    );

  /**
   * Cools what the failure kind names: a refused model alone, its provider until a usage window
   * resets (15 minutes when none reports one), the whole provider after a crash or timeout, and
   * a billing or sign-in failure until the provider is checked again.
   */
  const markFailed = (selection: ModelSelection, error: string | undefined) =>
    Effect.gen(function* () {
      const kind = crewFailureKind(error);
      const now = yield* Clock.currentTimeMillis;
      const provider = (yield* providers.getProviders).find(
        (entry) => entry.instanceId === selection.instanceId,
      );
      const blockModel = (block: {
        readonly reason: string;
        readonly until?: number;
        readonly windows?: FullWindows;
      }) => {
        const models = blockedModels.get(selection.instanceId) ?? new Map();
        models.set(selection.model, { selection, checkedAt: provider?.checkedAt ?? "", ...block });
        blockedModels.set(selection.instanceId, models);
      };
      if (kind === "model") {
        const key = modelKey(selection);
        // Refusals before the provider's next status check are one refusal: parallel tasks often
        // meet the same one at once.
        const held = blockedModels.get(selection.instanceId)?.get(selection.model);
        const sameCheck = held !== undefined && held.checkedAt === (provider?.checkedAt ?? "");
        const count = (refusals.get(key) ?? 0) + (sameCheck ? 0 : 1);
        refusals.set(key, count);
        blockModel(
          count === 1
            ? { reason: "model refused" }
            : { reason: "model refused again", until: now + REPEAT_REFUSAL_BLOCK_MS },
        );
        return;
      }
      if (kind === "limit") {
        const full = fullWindowsFor(provider, selection.model, now);
        const checkedAt = provider?.usageLimits?.checkedAt ?? "";
        if (full.provider.length > 0) {
          const latest = latestReset(full.provider);
          limitedProviders.set(selection.instanceId, {
            until: Date.parse(latest.resetsAt!),
            reason: `${latest.label} limit`,
            windows: { ids: full.provider.map((window) => window.id), checkedAt },
          });
          return;
        }
        if (full.model.length > 0) {
          const latest = latestReset(full.model);
          blockModel({
            reason: `${latest.label} limit`,
            until: Date.parse(latest.resetsAt!),
            windows: { ids: full.model.map((window) => window.id), checkedAt },
          });
          return;
        }
        const window = crewLimitWindowName(error);
        limitedProviders.set(selection.instanceId, {
          until: now + LIMIT_COOLDOWN_MS,
          reason: window === null ? "usage limit" : `${window} limit`,
        });
        return;
      }
      failedProviders.set(selection.instanceId, now + FAILED_PROVIDER_COOLDOWN_MS);
      if (kind === "other") return;
      blockedProviders.set(selection.instanceId, {
        checkedAt: provider?.checkedAt ?? "",
        reason: kind === "billing" ? "billing" : "sign-in required",
      });
    });

  /** A model that just finished a turn proves its provider works: its cooling ends now. */
  const markWorked = (selection: ModelSelection) => {
    failedProviders.delete(selection.instanceId);
    limitedProviders.delete(selection.instanceId);
    blockedProviders.delete(selection.instanceId);
    refusals.delete(modelKey(selection));
    const models = blockedModels.get(selection.instanceId);
    models?.delete(selection.model);
    if (models?.size === 0) blockedModels.delete(selection.instanceId);
  };

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const fail = (reason: string) => Effect.fail(new CrewError({ reason }));

  const persistTask = (record: Omit<CrewTaskRecord, "done" | "over" | "lock" | "checkLock">) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      const recordJson = yield* encodeTaskRecovery({
        version: 1,
        taskId: record.taskId,
        leadThreadId: record.leadThreadId,
        leadTurnId: record.leadTurnId,
        role: record.role,
        subject: record.subject,
        writeScope: record.writeScope,
        worktree: record.worktree,
        candidate: record.candidate,
        todos: record.todos,
        queued: record.queued,
        todoBase: record.todoBase,
        outOfScope: record.outOfScope,
        attempts: record.attempts,
        stopped: record.stopped,
        report: record.report,
        collected: record.collected,
        ended: record.ended,
        auditState: record.auditState,
      }).pipe(Effect.mapError(() => new CrewError({ reason: "Could not encode crew state." })));
      yield* recovery
        .saveTask({
          task_id: record.taskId,
          lead_thread_id: record.leadThreadId,
          record_json: recordJson,
          updated_at: updatedAt,
        })
        .pipe(Effect.mapError(() => new CrewError({ reason: "Could not persist crew state." })));
    });

  const updateTask = (
    record: CrewTaskRecord,
    patch: Partial<
      Pick<
        CrewTaskRecord,
        | "report"
        | "collected"
        | "ended"
        | "auditState"
        | "todos"
        | "queued"
        | "outOfScope"
        | "stopped"
      >
    >,
  ) =>
    record.lock.withPermits(1)(
      Effect.gen(function* () {
        yield* persistTask({ ...record, ...patch });
        Object.assign(record, patch);
      }),
    );

  const shellOf = (threadId: ThreadId) =>
    snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));

  const crewFor = Effect.fn("CrewService.crewFor")(function* (lead: OrchestrationThreadShell) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(() => new CrewError({ reason: "Could not read the crew settings." })),
    );
    const snapshot = yield* providers.getProviders;
    const resolved = resolveCrew({
      settings: current.crew,
      override: lead.crew,
      providers: snapshot,
      brain: lead.modelSelection,
    });
    // A provider that cannot be told the crew's brief and tools cannot lead; an unknown one is left alone.
    const driver = snapshot.find(
      (provider) => provider.instanceId === lead.modelSelection.instanceId,
    )?.driver;
    return {
      resolved,
      options: crewModelOptions(snapshot),
      canLead: driver === undefined || canLeadCrew(driver),
    };
  });

  /** Whether the lead's crew is on right now; an unreadable setting counts as on, as before. */
  const crewIsOn = (lead: OrchestrationThreadShell) =>
    crewFor(lead).pipe(
      Effect.map(({ resolved, canLead }) => resolved.enabled && canLead),
      Effect.orElseSucceed(() => true),
    );

  const appendActivity = (input: {
    /** A fixed id makes the activity replace the earlier one with that id. */
    readonly id?: string;
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly turnId: TurnId | null;
    readonly payload: Record<string, unknown>;
  }) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const activity: OrchestrationThreadActivity = {
        id: EventId.make(input.id ?? (yield* uuid)),
        tone: "info",
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: input.turnId,
        createdAt,
      };
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:crew-activity:${input.threadId}:${yield* uuid}`),
        threadId: input.threadId,
        activity,
        createdAt,
      });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("crew activity append failed", { cause })),
    );

  const statusOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map((shell) =>
        Option.isNone(shell) ? ("interrupted" as const) : crewTaskStatus(shell.value),
      ),
    );

  const lastErrorOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map((shell) =>
        Option.isNone(shell) ? null : (shell.value.session?.lastError ?? null),
      ),
    );

  /** The reason in a `provider.turn.start.failed` activity for this message, or null. */
  const startFailureReason = (
    activity: { readonly kind: string; readonly summary: string; readonly payload: unknown },
    messageId: MessageId,
  ) => {
    if (activity.kind !== "provider.turn.start.failed") return null;
    const payload = activity.payload as { requestId?: unknown; detail?: unknown } | null;
    if (payload?.requestId !== messageId) return null;
    return typeof payload.detail === "string" && payload.detail.length > 0
      ? payload.detail
      : activity.summary;
  };

  /**
   * Why the reactor refused this message before any turn started, or null. Read once, right after
   * subscribing, so a refusal appended before the subscription is not missed.
   */
  const startHoldOf = (threadId: ThreadId, messageId: MessageId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map((detail) => {
        if (Option.isNone(detail)) return null;
        for (const activity of detail.value.activities.toReversed()) {
          const reason = startFailureReason(activity, messageId);
          if (reason !== null) return reason;
        }
        return null;
      }),
      Effect.orElseSucceed(() => null),
    );

  /**
   * How a refused start ends the wait. Only a memory hold that left the session ready (no error)
   * is a hold. A session error is a real failure, so the task fails over. Only the reactor's own
   * stop reasons are a stop; any other refusal (a failed resume after compaction, a missing
   * message, a queued message cancelled) is a failure and fails over.
   */
  const startFailureOutcome = (threadId: ThreadId, reason: string) =>
    lastErrorOf(threadId).pipe(
      Effect.map((error) =>
        error !== null
          ? { status: "failed" as CrewTaskStatus, held: null as string | null }
          : MEMORY_HOLD_DETAILS.has(reason)
            ? { status: "failed" as CrewTaskStatus, held: reason as string | null }
            : STOPPED_START_DETAILS.has(reason)
              ? { status: "interrupted" as CrewTaskStatus, held: null as string | null }
              : { status: "failed" as CrewTaskStatus, held: null as string | null },
      ),
    );

  /**
   * Resolves when the thread settles or the message that should start its turn is refused. Only
   * an event that can change the thread's status is the cue to re-read it; the refusal itself is
   * spotted from its own event, so a streaming member costs no thread reads.
   */
  const settleOrHold = (
    threadId: ThreadId,
    messageId: MessageId,
    readStatus: Effect.Effect<CrewTaskStatus>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const status = yield* readStatus;
        if (isSettledCrewStatus(status)) return { status, held: null as string | null };
        const earlier = yield* startHoldOf(threadId, messageId);
        if (earlier !== null) return yield* startFailureOutcome(threadId, earlier);
        const next = yield* events.pipe(
          Stream.filter(
            (event) =>
              event.aggregateId === threadId &&
              (event.type === "thread.activity-appended" || STATUS_EVENTS.has(event.type)),
          ),
          Stream.mapEffect((event) => {
            const reason =
              event.type === "thread.activity-appended"
                ? startFailureReason(event.payload.activity, messageId)
                : null;
            if (reason !== null) return startFailureOutcome(threadId, reason);
            return event.type === "thread.activity-appended"
              ? Effect.succeed({ status: "running" as CrewTaskStatus, held: null })
              : readStatus.pipe(
                  Effect.map((current) => ({ status: current, held: null }) as const),
                );
          }),
          Stream.filter((outcome) => isSettledCrewStatus(outcome.status)),
          Stream.runHead,
        );
        return Option.getOrElse(next, () => ({
          status: "interrupted" as CrewTaskStatus,
          held: null as string | null,
        }));
      }),
    );

  const settled = (threadId: ThreadId, messageId: MessageId) =>
    settleOrHold(threadId, messageId, statusOf(threadId));

  const lastAssistantText = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map((thread) => {
        if (Option.isNone(thread)) return null;
        const reply = thread.value.messages.findLast((message) => message.role === "assistant");
        return reply === undefined ? null : reply.text;
      }),
      Effect.orElseSucceed(() => null),
    );

  const settleThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`server:crew-settle:${threadId}:${yield* uuid}`),
        threadId,
      });
    }).pipe(Effect.ignore);

  /**
   * Interrupts the turn the task's current member is running, through the same command the Stop
   * button sends. A thread that does not exist yet, or has settled, has nothing to interrupt.
   */
  const interruptMember = (record: CrewTaskRecord) =>
    Effect.gen(function* () {
      const threadId = record.attempts.at(-1)?.threadId;
      if (threadId === undefined) return;
      if (record.sending !== true && isSettledCrewStatus(yield* statusOf(threadId))) return;
      yield* engine.dispatch({
        type: "thread.turn.interrupt",
        commandId: CommandId.make(`server:crew-stop:${threadId}:${yield* uuid}`),
        threadId,
        createdAt: yield* nowIso,
      });
    }).pipe(Effect.ignore);

  const launchCrewThread = Effect.fn("CrewService.launchCrewThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly lead: OrchestrationThreadShell;
    readonly role: CrewRole;
    readonly option: CrewModelOption;
    readonly subject: string;
    readonly prompt: string;
    /** An isolated task works here, on no branch, instead of in the lead's workspace. */
    readonly worktree?: CrewWorktree | undefined;
    /** Memories to attach by reference; only for a member whose provider may receive memory. */
    readonly memory?: ReadonlyArray<CrewMemoryRef> | undefined;
  }) {
    const threadId = input.threadId;
    const createdAt = yield* nowIso;
    const interactionMode = input.role === "auditor" ? "plan" : "default";
    const message = withCrewMemoryReferences(input.prompt, input.memory ?? []);
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`server:crew-create:${threadId}`),
      threadId,
      projectId: input.lead.projectId,
      title: crewThreadTitle(input.role, input.subject),
      modelSelection: input.option.selection,
      runtimeMode: input.lead.runtimeMode,
      interactionMode,
      branch: input.worktree === undefined ? input.lead.branch : null,
      worktreePath: input.worktree?.cwd ?? input.lead.worktreePath,
      parentThreadId: input.lead.id,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:crew-turn:${threadId}`),
      threadId,
      message: {
        messageId: input.messageId,
        role: "user",
        text: message.text,
        attachments: [],
        ...(message.context === undefined ? {} : { context: message.context }),
      },
      runtimeMode: input.lead.runtimeMode,
      interactionMode,
      createdAt,
    });
    return threadId;
  });

  const leadIdle = (lead: OrchestrationThreadShell) =>
    lead.latestTurn !== null &&
    lead.latestTurn.state !== "running" &&
    lead.session?.status !== "running" &&
    lead.session?.status !== "starting";

  /**
   * Whether the user stopped the lead's latest turn. Crew results that arrive after that wait for
   * the user's next turn instead of starting the lead again.
   */
  const leadStopped = (lead: OrchestrationThreadShell) =>
    lead.latestTurn !== null &&
    (lead.latestTurn.state === "interrupted" || isStoppedLeadTurn(lead.id, lead.latestTurn.turnId));

  const latestUserText = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map((thread) =>
        Option.isNone(thread)
          ? null
          : (thread.value.messages.findLast((message) => message.role === "user")?.text ?? null),
      ),
      Effect.orElseSucceed(() => null),
    );

  /**
   * What the lead thread says about a finished turn's risk: whether the turn ended on a passing test
   * run, and whether the latest audit asked for changes. Unreadable means untested and asked.
   */
  const turnAuditSignals = (threadId: ThreadId, turnId: TurnId) =>
    snapshots
      .getThreadDetailById(threadId, { activityKinds: ["tool.completed", "task.completed"] })
      .pipe(
        Effect.map((thread) =>
          Option.isNone(thread)
            ? { testsPassed: false, changesRequested: true }
            : {
                testsPassed: turnRanPassingTests(turnId, thread.value.activities),
                changesRequested: latestAuditAsksChanges(thread.value.activities),
              },
        ),
        Effect.orElseSucceed(() => ({ testsPassed: false, changesRequested: true })),
      );

  /**
   * What the board shows for a finished crew attempt: its thread's token and cost totals, and
   * whether its last turn ended on a passing test run. Only this attempt counts; earlier models
   * in the fallback chain are not added in. A turn's usage is appended just after its terminal
   * status, so a thread without any yet gets a short wait for it.
   */
  const readThreadFacts = (threadId: ThreadId) =>
    snapshots
      .getThreadDetailById(threadId, {
        activityKinds: [OWNED_USAGE_ACTIVITY_KIND, "tool.completed"],
      })
      .pipe(
        Effect.map((thread) => ({
          usage: Option.isNone(thread) ? null : crewThreadUsage(thread.value.activities),
          testsPassed:
            Option.isSome(thread) && thread.value.latestTurn !== null
              ? turnRanPassingTests(thread.value.latestTurn.turnId, thread.value.activities)
              : false,
        })),
      );

  const crewThreadFacts = (threadId: ThreadId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const read = readThreadFacts(threadId);
        const first = yield* read;
        if (first.usage !== null) return first;
        yield* events.pipe(
          Stream.filter(
            (event) =>
              event.aggregateId === threadId &&
              event.type === "thread.activity-appended" &&
              event.payload.activity.kind === OWNED_USAGE_ACTIVITY_KIND,
          ),
          Stream.runHead,
          Effect.timeoutOption(Duration.seconds(1)),
        );
        return yield* read;
      }),
    ).pipe(Effect.catchCause(() => Effect.succeed({ usage: null, testsPassed: false })));

  /**
   * What a finished task's thread shows: the `tested` and `usage` fields of its board activity,
   * and `testsPassed`, the passing test run OOP itself observed (not the member's say-so), which
   * its proof is judged on.
   */
  const completionEvidence = (
    threadId: ThreadId,
    role: CrewRole,
    report: CrewMemberReport | undefined,
  ) =>
    crewThreadFacts(threadId).pipe(
      Effect.map(({ usage, testsPassed }) => ({
        testsPassed,
        evidence: {
          // Observed (a passing test run in the thread) or self-reported by the member's JSON report.
          ...(role === "auditor"
            ? {}
            : { tested: testsPassed || report?.verification?.passed === true }),
          ...(usage === null ? {} : { usage }),
        },
      })),
    );

  /** The proof of a finished worker or expert task; null for an auditor, whose verdict stands in. */
  const proofOf = (
    record: CrewTaskRecord,
    status: CrewTaskOutcome,
    observedTests: boolean,
    report: CrewMemberReport | undefined,
  ): TaskProof | null =>
    record.role === "auditor"
      ? null
      : taskProof({
          status,
          todos: record.todos === undefined ? undefined : todoCounts(record.todos),
          observedTests,
          selfReportedPassed: report?.verification?.passed,
        });

  /** The last message the user wrote in a lead thread, skipping OOP's crew follow-ups. */
  const latestRequestText = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map((thread) =>
        Option.isNone(thread)
          ? null
          : (thread.value.messages.findLast(
              (message) => message.role === "user" && !isCrewFollowUp(message.text),
            )?.text ?? null),
      ),
      Effect.orElseSucceed(() => null),
    );

  /** Records that the lead has a report, so it is never handed over twice. */
  const markCollected = (
    taskId: string,
    record: CrewTaskRecord,
    extra: Record<string, unknown> = {},
  ) =>
    Effect.gen(function* () {
      const changed = yield* record.lock.withPermits(1)(
        Effect.gen(function* () {
          if (record.collected || record.role === "auditor") return false;
          yield* persistTask({ ...record, collected: true });
          record.collected = true;
          return true;
        }),
      );
      if (!changed) return;
      yield* appendActivity({
        threadId: record.leadThreadId,
        kind: "task.collected",
        summary: `${CREW_ROLE_LABEL[record.role]} report reached the lead: ${record.subject}`,
        turnId: record.leadTurnId,
        payload: { taskId, crewRole: record.role, ...extra },
      });
    });

  /** Ends a task on the lead's board when its run broke off; a thread goal waits for every audit. */
  const endBrokenTask = (input: {
    readonly lead: OrchestrationThreadShell;
    readonly leadTurnId: TurnId | null;
    readonly taskId: string;
    readonly role: CrewRole;
    readonly subject: string;
    readonly summary: string;
    /** The final TODO counts, when the task had a list. */
    readonly todos?: Record<string, unknown>;
  }) =>
    appendActivity({
      threadId: input.lead.id,
      kind: "task.completed",
      summary: input.summary,
      turnId: input.leadTurnId,
      payload: {
        taskId: input.taskId,
        title: input.subject,
        agentKind: "agent",
        crewRole: input.role,
        status: "failed",
        ...input.todos,
      },
    }).pipe(Effect.ignore);

  /** An audit's fix request is dropped once the crew is off; the thread's activity says why. */
  const skipAuditFixForCrewOff = (record: CrewTaskRecord) =>
    Effect.gen(function* () {
      yield* updateTask(record, { auditState: "skipped" });
      yield* appendActivity({
        threadId: record.leadThreadId,
        kind: CREW_AUDIT_SKIPPED_ACTIVITY,
        summary: "Audit fix request dropped: OOP Crew is off",
        turnId: record.leadTurnId,
        payload: { crewRole: "auditor", crewOff: true },
      });
    });

  /**
   * An audit that asked for changes becomes a follow-up lead turn while the fix limit allows.
   * The follow-up is announced before the audit's completion so nothing watching the lead sees
   * a quiet thread in between.
   */
  const queueAuditFix = (record: CrewTaskRecord, report: string | null) =>
    Effect.gen(function* () {
      if (record.auditState !== "none") return;
      // A stopped task must not restart the lead through a fix turn.
      if (record.stopped !== undefined) {
        yield* updateTask(record, { auditState: "skipped" });
        return;
      }
      const current = followUpRound(yield* latestUserText(record.leadThreadId));
      if (auditVerdict(report) === "needs-changes" && report !== null) {
        const lead = yield* shellOf(record.leadThreadId);
        if (Option.isSome(lead) && !(yield* crewIsOn(lead.value))) {
          yield* skipAuditFixForCrewOff(record);
          return;
        }
      }
      if (
        auditVerdict(report) !== "needs-changes" ||
        report === null ||
        current.fixes >= CREW_MAX_FIX_ROUNDS ||
        current.round >= CREW_MAX_FOLLOW_UPS
      ) {
        yield* updateTask(record, { auditState: "skipped" });
        return;
      }
      yield* updateTask(record, { auditState: "pending" });
      yield* appendActivity({
        threadId: record.leadThreadId,
        kind: "crew.follow-up",
        summary: "The auditor asked for changes; the lead gets a follow-up turn",
        turnId: record.leadTurnId,
        payload: { reason: "audit" },
      });
    });

  /**
   * The checklist's progress row on the lead's board. Its fixed id makes every call replace the
   * last one, so the board keeps one row per task however often items change.
   */
  const emitProgress = (
    record: CrewTaskRecord,
    status: "running" | "stopped" = "running",
    /** Replaces the checklist line, e.g. "waiting for capacity" while the task is queued. */
    note?: string,
  ) =>
    record.todos === undefined && status === "running" && note === undefined
      ? Effect.void
      : appendActivity({
          id: crewTaskProgressActivityId(record.taskId),
          threadId: record.leadThreadId,
          kind: "task.progress",
          summary:
            note !== undefined
              ? `${CREW_ROLE_LABEL[record.role]} ${note}: ${record.subject}`
              : status === "stopped"
                ? `${CREW_ROLE_LABEL[record.role]} stopping: ${record.subject}`
                : `${CREW_ROLE_LABEL[record.role]} checklist ${todoCounts(record.todos ?? []).verified} of ${record.todos?.length ?? 0} verified: ${record.subject}`,
          turnId: record.leadTurnId,
          payload: {
            taskId: record.taskId,
            title: record.subject,
            agentKind: "agent",
            crewRole: record.role,
            ...(record.live === undefined
              ? {}
              : {
                  threadId: record.live.threadId,
                  model: record.live.model,
                  providerInstanceId: record.live.providerInstanceId,
                }),
            status,
            ...(status === "stopped" && record.stopped !== undefined
              ? { summary: record.stopped }
              : {}),
            ...todoPayload(record),
          },
        });

  /** How a server-run check is carried out; a sweep reuses one result per command. */
  interface CheckRun {
    readonly command: (cwd: string, command: string) => Effect.Effect<TodoCommandResult>;
    readonly changed: (cwd: string, tree: string) => Effect.Effect<ReadonlyArray<string> | null>;
  }
  const checkRun = (reuse: boolean): CheckRun => {
    const commands = new Map<string, TodoCommandResult>();
    let changed: ReadonlyArray<string> | null | undefined;
    return {
      command: (cwd, command) =>
        Effect.gen(function* () {
          const known = reuse ? commands.get(command) : undefined;
          if (known !== undefined) return known;
          const result = yield* todoChecks.runCommand({ cwd, command });
          if (reuse) commands.set(command, result);
          return result;
        }),
      changed: (cwd, tree) =>
        Effect.gen(function* () {
          if (reuse && changed !== undefined) return changed;
          const result = yield* todoChecks.changedSince(cwd, tree);
          if (reuse) changed = result;
          return result;
        }),
    };
  };

  type Evaluation =
    | { readonly kind: "verified" }
    /** The check passed but cannot be trusted, so the item is only claimed. */
    | { readonly kind: "untrusted"; readonly detail: string }
    | { readonly kind: "failed"; readonly detail: string; readonly output?: string }
    /** The check did not finish in time: not a pass and not a proven failure. */
    | { readonly kind: "inconclusive"; readonly detail: string; readonly output?: string }
    /** The check could not run at all, which says nothing about the work. */
    | { readonly kind: "unavailable"; readonly detail: string };

  /**
   * Of the files a failed check lists, those that never existed in the workspace at all: absent
   * when the task started (hash null) and absent again now. Only hash-fallback mode can tell,
   * which is why git mode keeps the "have not changed" wording: there the paths resolve against
   * the repo root, which may differ from the cwd this message would name.
   */
  const neverCreatedFiles = (
    cwd: string,
    hashes: Readonly<Record<string, string | null>>,
    files: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const still = yield* todoChecks.hashFiles(cwd, files);
      return files.filter((file) => hashes[file] === null && still[file] === null);
    });

  /**
   * Runs an item's check. `outside` is every file changed outside writeScope as far as it could
   * be read (null: unknown, so the last answer stands).
   *
   * A shared workspace also holds the lead's and other tasks' edits, so there an out-of-scope
   * change cannot be pinned on this member: it is reported as possibly someone else's and leaves
   * command results alone. Only a `files` item that is satisfied by out-of-scope files alone is
   * refused, since the check itself points outside the scope. In the task's own worktree every
   * change is the member's, so a command result is not trusted while any exists.
   */
  const evaluateTodo = (record: CrewTaskRecord, item: TodoItem, run: CheckRun) =>
    Effect.gen(function* () {
      const check = item.check;
      const base = record.todoBase;
      if (check === undefined)
        return { evaluation: { kind: "verified" } as Evaluation, outside: null };
      if (base === undefined) {
        return {
          evaluation: {
            kind: "unavailable",
            detail: "This task has no known workspace to run the check in.",
          } as Evaluation,
          outside: null,
        };
      }
      const wantsChanged = check.files !== undefined || (record.writeScope?.length ?? 0) > 0;
      const changed =
        wantsChanged && base.tree !== null
          ? yield* run.changed(base.cwd, base.tree)
          : check.files !== undefined && base.hashes !== undefined
            ? yield* todoChecks.changedHashes(base.cwd, base.hashes, check.files)
            : null;
      const outside =
        changed === null || base.tree === null
          ? null
          : filesOutsideScope(changed, record.writeScope);
      const answer = (evaluation: Evaluation) => ({ evaluation, outside });
      let outOfScopeOnly: ReadonlyArray<string> = [];
      if (check.files !== undefined) {
        if (changed === null) {
          return answer({
            kind: "untrusted",
            detail:
              "The workspace could not be compared with how it was when the task started (is it a git repository?), so the files were not checked.",
          });
        }
        const verdict = judgeFilesCheck({
          files: check.files,
          changed,
          writeScope: record.writeScope,
        });
        if (verdict.kind === "failed") {
          // In hash-fallback mode a path absent at the start and still absent hashes null both
          // times, which reads as "unchanged" and misleads the member into editing again when the
          // real problem is the path. Name those as missing; keep the unchanged wording for files
          // that exist but were not touched.
          const hashes = base.tree === null ? base.hashes : undefined;
          const absent =
            hashes === undefined ? [] : yield* neverCreatedFiles(base.cwd, hashes, verdict.missing);
          const unchanged = verdict.missing.filter((file) => !absent.includes(file));
          return answer({
            kind: "failed",
            detail: [
              ...(absent.length > 0
                ? [
                    `These files do not exist in ${base.cwd}: ${absent.join(", ")}. Check paths are resolved against that directory; fix the path in the check.`,
                  ]
                : []),
              ...(unchanged.length > 0
                ? [`These files have not changed since the task started: ${unchanged.join(", ")}.`]
                : []),
            ].join(" "),
          });
        }
        outOfScopeOnly = verdict.outOfScopeOnly;
      }
      if (check.command !== undefined) {
        // A command runs in the server's environment, outside any sandbox. A member that was
        // sandboxed may have edited what the command runs, so only full-access threads qualify.
        const threads = [record.leadThreadId, ...(record.live ? [record.live.threadId] : [])];
        const shells = yield* Effect.forEach(threads, shellOf);
        if (
          !shells.every(
            (shell) => Option.isSome(shell) && shell.value.runtimeMode === "full-access",
          )
        ) {
          return answer({
            kind: "untrusted",
            detail:
              "The command was not run: this chat is sandboxed (not full access), and a check command runs outside the sandbox, so the item is only claimed.",
          });
        }
        const result = yield* run.command(base.cwd, check.command);
        if (result.kind === "failed") {
          return answer({
            kind: "failed",
            detail: `The command exited with code ${result.exitCode ?? "unknown"}.`,
            output: result.tail,
          });
        }
        if (result.kind === "timeout") {
          return answer({
            kind: "inconclusive",
            detail: `INCONCLUSIVE: the command did not finish within ${Duration.toSeconds(TODO_COMMAND_TIMEOUT)} seconds; a timeout is not a pass and not a proven failure.`,
            output: result.tail,
          });
        }
        if (result.kind === "error") {
          return answer({
            kind: "unavailable",
            detail: `The command could not run: ${result.message}`,
          });
        }
      }
      if (outOfScopeOnly.length > 0) {
        return answer({
          kind: "untrusted",
          detail: `The files changed only outside the write scope (${outOfScopeOnly.join(", ")}), so they do not count.`,
        });
      }
      if (
        check.command !== undefined &&
        record.worktree !== undefined &&
        outside !== null &&
        outside.length > 0
      ) {
        return answer({
          kind: "untrusted",
          detail: `The command passed, but this task changed files outside its write scope (${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ", ..." : ""}), so the result is not trusted.`,
        });
      }
      return answer({ kind: "verified" });
    });

  /** The item after a check; `phase` decides what a check that could not run means. */
  const settleItem = (
    item: TodoItem,
    evaluation: Evaluation,
    phase: "check" | "sweep",
  ): TodoItem => {
    switch (evaluation.kind) {
      case "verified":
        return { ...item, status: "verified", detail: undefined };
      case "untrusted":
        return { ...item, status: "claimed", detail: evaluation.detail };
      case "failed":
        return {
          ...item,
          status: "failed",
          detail:
            phase === "sweep"
              ? `Failed when the task ended. ${evaluation.detail}`
              : evaluation.detail,
        };
      case "inconclusive":
        // Like a check that cannot run: the member may fix a slow check, but the sweep proved
        // nothing either way, so the item stays claimed instead of reading as a real failure.
        return {
          ...item,
          status: phase === "check" ? "failed" : "claimed",
          detail: evaluation.detail,
        };
      case "unavailable":
        // A check that cannot run proves nothing; a member may try again, a sweep cannot ask it to.
        return {
          ...item,
          status: phase === "check" ? "failed" : "claimed",
          detail: evaluation.detail,
        };
    }
  };

  /** Replaces one item, and the out-of-scope sample when the check could read it. */
  const replaceTodos = (
    record: CrewTaskRecord,
    items: ReadonlyMap<string, TodoItem>,
    outside: ReadonlyArray<string> | null,
  ) =>
    updateTask(record, {
      todos: (record.todos ?? []).map((todo) => items.get(todo.id) ?? todo),
      ...(outside === null
        ? {}
        : { outOfScope: summarizeOutOfScope(outside, record.worktree === undefined) }),
    });

  const checkTodo: CrewService["Service"]["checkTodo"] = Effect.fn("CrewService.checkTodo")(
    function* (input) {
      const shell = yield* shellOf(input.threadId);
      if (Option.isNone(shell) || !isCrewThreadTitle(shell.value.title)) {
        return yield* fail("Only crew members can check off TODO items.");
      }
      const record = [...tasks.values()].find((entry) =>
        entry.attempts.some((attempt) => attempt.threadId === input.threadId),
      );
      if (record === undefined) return yield* fail("This thread is not working on a crew task.");
      if (record.todos === undefined) return yield* fail("This crew task has no TODO list.");
      // An earlier attempt of a task that fell back to another model no longer owns the list.
      if (record.attempts.at(-1)?.threadId !== input.threadId) {
        return yield* fail("Another model took this task over; its TODO list is no longer yours.");
      }
      const note = input.note?.trim() ?? "";
      return yield* record.checkLock.withPermits(1)(
        Effect.gen(function* () {
          if (record.closed === true || record.report !== null) {
            return yield* fail("This task has ended; its TODO list is closed.");
          }
          const found = (record.todos ?? []).find((todo) => todo.id === input.todoId.trim());
          if (found === undefined) {
            return yield* fail(
              `Unknown TODO id ${input.todoId}. Valid ids: ${(record.todos ?? []).map((todo) => todo.id).join(", ")}.`,
            );
          }
          const reply = (
            item: TodoItem,
            extra: { readonly alreadyChecked: boolean; readonly output?: string },
          ): CrewTodoCheckResult => ({
            todoId: item.id,
            status: item.status,
            alreadyChecked: extra.alreadyChecked,
            remaining: openTodoIds(record.todos ?? []),
            ...(item.detail !== undefined && item.status !== "verified"
              ? { message: item.detail }
              : {}),
            ...(extra.output === undefined ? {} : { output: extra.output }),
          });
          // A settled item is not run or changed again; the final sweep is what re-proves it.
          if (found.status === "verified" || found.status === "claimed") {
            return reply(found, { alreadyChecked: true });
          }
          if (input.status === "blocked") {
            if (note === "") return yield* fail("Say what blocks this item in `note`.");
            if (found.status === "blocked" && found.note === note) {
              return reply(found, { alreadyChecked: true });
            }
            const blocked: TodoItem = { ...found, status: "blocked", note, detail: undefined };
            yield* replaceTodos(record, new Map([[found.id, blocked]]), null);
            yield* emitProgress(record);
            return reply(blocked, { alreadyChecked: false });
          }
          if (found.check === undefined) {
            if (note === "") {
              return yield* fail(
                "This item has no server check, so say in `note` what you did and how you know it works.",
              );
            }
            const claimed: TodoItem = { ...found, status: "claimed", note, detail: undefined };
            yield* replaceTodos(record, new Map([[found.id, claimed]]), null);
            yield* emitProgress(record);
            return reply(claimed, { alreadyChecked: false });
          }
          const { evaluation, outside } = yield* evaluateTodo(record, found, checkRun(false));
          const settled = settleItem(note === "" ? found : { ...found, note }, evaluation, "check");
          yield* replaceTodos(record, new Map([[found.id, settled]]), outside);
          yield* emitProgress(record);
          return reply(settled, {
            alreadyChecked: false,
            ...((evaluation.kind === "failed" || evaluation.kind === "inconclusive") &&
            evaluation.output !== undefined
              ? { output: evaluation.output }
              : {}),
          });
        }),
      );
    },
  );

  /**
   * At the end of a task, runs every verified item's check again, so work that a later edit
   * broke does not stay verified. Only a regression is recorded: an item never becomes verified
   * here, and the list is closed to further checks.
   */
  const sweepTodos = (record: CrewTaskRecord) =>
    record.checkLock.withPermits(1)(
      Effect.gen(function* () {
        record.closed = true;
        const targets = (record.todos ?? []).filter(
          (todo) => todo.status === "verified" && todo.check !== undefined,
        );
        if (targets.length === 0) return;
        const run = checkRun(true);
        const settled = new Map<string, TodoItem>();
        let outside: ReadonlyArray<string> | null = null;
        for (const item of targets) {
          const result = yield* evaluateTodo(record, item, run);
          outside = result.outside ?? outside;
          if (result.evaluation.kind !== "verified") {
            settled.set(item.id, settleItem(item, result.evaluation, "sweep"));
          }
        }
        yield* replaceTodos(record, settled, outside);
        yield* emitProgress(record);
      }),
    );

  /** Resolves with whether the thread is idle, waiting a little for a turn still winding down. */
  const awaitIdle = (threadId: ThreadId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const idle = shellOf(threadId).pipe(
          Effect.map((shell) => Option.isSome(shell) && leadIdle(shell.value)),
        );
        if (yield* idle) return true;
        const next = yield* events.pipe(
          Stream.filter((event) => event.aggregateId === threadId),
          Stream.mapEffect(() => idle),
          Stream.filter((ready) => ready),
          Stream.runHead,
        );
        return Option.isSome(next);
      }),
    ).pipe(
      Effect.timeoutOption(Duration.seconds(NUDGE_IDLE_WAIT_SECONDS)),
      Effect.map((idle) => Option.isSome(idle) && idle.value),
    );

  /** Like settled, but only for a turn other than `previous`, which is the one that just ended. */
  const settledAfter = (threadId: ThreadId, previous: TurnId | null, messageId: MessageId) =>
    settleOrHold(
      threadId,
      messageId,
      shellOf(threadId).pipe(
        Effect.map((shell) =>
          Option.isNone(shell) ||
          shell.value.latestTurn === null ||
          shell.value.latestTurn.turnId === previous
            ? ("running" as const)
            : crewTaskStatus(shell.value),
        ),
      ),
    );

  /**
   * Sends the member one more turn once its thread is idle, so it cannot land on a running turn.
   * Returns the status that turn ends with, or null when it could not be sent.
   */
  const followUpTurn = (input: {
    readonly lead: OrchestrationThreadShell;
    readonly record: CrewTaskRecord;
    readonly threadId: ThreadId;
    readonly kind: "nudge" | "added";
    readonly text: string;
  }) =>
    Effect.gen(function* () {
      const { threadId, record } = input;
      if (!(yield* awaitIdle(threadId))) return null;
      // Checking for a stop and sending happen under the record's lock, like the stop's own mark,
      // so a stop either sees this turn and interrupts it or is seen here and nothing is sent.
      // The wait for the turn to settle is outside the lock.
      const sent = yield* record.lock.withPermits(1)(
        Effect.gen(function* () {
          if (record.stopped !== undefined) return null;
          const before = (yield* shellOf(threadId)).pipe(
            Option.flatMap((shell) => Option.fromNullishOr(shell.latestTurn?.turnId)),
          );
          const messageId = MessageId.make(yield* uuid);
          // Set before the send, inside the lock: a stop that sees `stopped` unset here is
          // ordered after this and finds the mark, even while the thread still reads as idle.
          record.sending = true;
          const dispatched = yield* Effect.exit(
            engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.make(`server:crew-${input.kind}:${threadId}:${yield* uuid}`),
              threadId,
              message: {
                messageId,
                role: "user",
                text: input.text,
                attachments: [],
              },
              runtimeMode: input.lead.runtimeMode,
              interactionMode: "default",
              createdAt: yield* nowIso,
            }),
          );
          if (Exit.isSuccess(dispatched)) return { before, messageId };
          record.sending = false;
          return null;
        }),
      );
      // The old turn still reads as completed until the provider starts the new one.
      if (sent === null) return null;
      const { before, messageId } = sent;
      const ended = yield* settledAfter(threadId, Option.getOrNull(before), messageId).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            record.sending = false;
          }),
        ),
      );
      // A held message starts no turn: the task ends blocked on it rather than waiting forever.
      if (ended.held !== null) {
        record.held = ended.held;
        return null;
      }
      return ended.status;
    });

  /**
   * A member whose turn ended with items it never marked gets one more turn to mark them, once
   * per task. Items the lead added and has not delivered yet are not the member's to mark, and a
   * delivered batch gets its own nudge (`only`). Returns the status the task ends with.
   */
  const nudgePending = (input: {
    readonly lead: OrchestrationThreadShell;
    readonly record: CrewTaskRecord;
    readonly threadId: ThreadId;
    readonly status: CrewTaskStatus;
    readonly only?: ReadonlyArray<string> | undefined;
  }) =>
    Effect.gen(function* () {
      const { record, threadId } = input;
      const queued = record.queued ?? [];
      const pending = (record.todos ?? []).filter(
        (todo) =>
          todo.status === "pending" &&
          !queued.includes(todo.id) &&
          (input.only === undefined || input.only.includes(todo.id)),
      );
      const used = input.only === undefined && record.nudged === true;
      if (
        input.status !== "completed" ||
        pending.length === 0 ||
        used ||
        record.stopped !== undefined
      )
        return input.status;
      if (input.only === undefined) record.nudged = true;
      const ended = yield* followUpTurn({
        lead: input.lead,
        record,
        threadId,
        kind: "nudge",
        text: nudgeText(pending),
      });
      return ended ?? input.status;
    });

  /**
   * Hands the member the items the lead added while it worked, one follow-up turn per round, each
   * batch with its own nudge. Looking at the queue and closing the list happen together, so an
   * item added after the last round is refused instead of lost. Returns the final status.
   */
  const deliverAdded = (input: {
    readonly lead: OrchestrationThreadShell;
    readonly record: CrewTaskRecord;
    readonly threadId: ThreadId;
    readonly status: CrewTaskStatus;
  }) =>
    Effect.gen(function* () {
      const { record } = input;
      let status = input.status;
      while (status === "completed" && record.stopped === undefined) {
        const batch = yield* record.checkLock.withPermits(1)(
          Effect.sync(() => {
            const ids = record.queued ?? [];
            if (ids.length === 0) record.closed = true;
            return (record.todos ?? []).filter((todo) => ids.includes(todo.id));
          }),
        );
        if (batch.length === 0) break;
        yield* updateTask(record, { queued: [] });
        const ended = yield* followUpTurn({
          lead: input.lead,
          record,
          threadId: input.threadId,
          kind: "added",
          text: addedTodosText(batch),
        });
        if (ended === null) break;
        status = yield* nudgePending({
          ...input,
          status: ended,
          only: batch.map((todo) => todo.id),
        });
      }
      return status;
    });

  const decodeFollowUp = (checkpoint: CrewFollowUpCheckpoint) =>
    Effect.gen(function* () {
      const data = yield* decodeFollowUpRecovery(checkpoint.record_json).pipe(
        Effect.mapError(() => new CrewError({ reason: "Invalid crew delivery checkpoint." })),
      );
      if (
        data.command.commandId !== checkpoint.command_id ||
        data.command.message.messageId !== checkpoint.message_id ||
        data.command.threadId !== checkpoint.lead_thread_id
      )
        return yield* fail("Crew delivery checkpoint identities do not match.");
      return data;
    });

  const finishFollowUp = (
    checkpoint: CrewFollowUpCheckpoint,
    data: typeof CrewFollowUpRecoveryJson.Type,
  ) =>
    Effect.gen(function* () {
      const collected: CrewTaskRecord[] = [];
      const audits: CrewTaskRecord[] = [];
      for (const taskId of data.taskIds) {
        const record = tasks.get(taskId);
        if (
          record === undefined ||
          record.role === "auditor" ||
          record.leadThreadId !== checkpoint.lead_thread_id
        )
          return yield* fail("Crew delivery refers to an unknown task.");
        collected.push(record);
      }
      for (const taskId of data.auditTaskIds) {
        const record = tasks.get(taskId);
        if (
          record === undefined ||
          record.role !== "auditor" ||
          record.leadThreadId !== checkpoint.lead_thread_id
        )
          return yield* fail("Crew delivery refers to an unknown audit.");
        audits.push(record);
      }
      yield* recovery.acknowledgeFollowUp(checkpoint.delivery_id, yield* nowIso);
      for (const record of collected) {
        yield* markCollected(record.taskId, record);
      }
      for (const record of audits) {
        if (record.auditState !== "delivered") {
          yield* updateTask(record, { auditState: "delivered" });
        }
      }
      // Everything the delivery stood for is recorded on the tasks, so the row has no use left.
      yield* recovery.deleteFollowUp(checkpoint.delivery_id);
    });

  /**
   * Hands the lead what the crew finished after it answered (audit fixes, uncollected reports)
   * as one follow-up turn, once the lead is idle and no audit of its last turn is running.
   */
  /** A task still at work: no report yet, and its run has neither ended nor broken off. */
  const stillRunning = (record: CrewTaskRecord) =>
    record.report === null
      ? Effect.map(Deferred.isDone(record.over), (done) => !done)
      : Effect.succeed(false);

  const flushLead = (leadId: ThreadId) =>
    followUpLock
      .withPermits(1)(
        Effect.gen(function* () {
          const pending = (yield* recovery.readPendingFollowUps(leadId))[0];
          if (pending !== undefined) {
            const data = yield* decodeFollowUp(pending);
            const receipt = yield* receipts.getByCommandId({ commandId: data.command.commandId });
            if (Option.isSome(receipt)) {
              if (receipt.value.aggregateKind !== "thread" || receipt.value.aggregateId !== leadId)
                return yield* fail("Crew delivery command belongs to another thread.");
              if (receipt.value.status === "accepted") {
                yield* finishFollowUp(pending, data);
                return;
              }
              yield* recovery.rejectFollowUp(pending.delivery_id, yield* nowIso);
              yield* recovery.deleteFollowUp(pending.delivery_id);
            } else {
              const lead = yield* shellOf(leadId);
              if (Option.isNone(lead) || !leadIdle(lead.value) || leadStopped(lead.value)) return;
              yield* engine.dispatch(data.command);
              yield* finishFollowUp(pending, data);
              return;
            }
          }
          const lead = yield* shellOf(leadId);
          if (
            Option.isNone(lead) ||
            isCrewThreadTitle(lead.value.title) ||
            !leadIdle(lead.value) ||
            leadStopped(lead.value)
          )
            return;
          const records = [...tasks.entries()].filter(
            ([, record]) => record.leadThreadId === leadId,
          );
          if (records.some(([, record]) => record.role === "auditor" && record.report === null))
            return;
          const crewOff = !(yield* crewIsOn(lead.value));
          const auditRecords = records.filter(([, record]) => record.auditState === "pending");
          if (crewOff) {
            // The audit loop is crew work the user switched off, so a waiting fix request is dropped.
            for (const [, record] of auditRecords) yield* skipAuditFixForCrewOff(record);
          }
          const audits = auditRecords.flatMap(([, record]) =>
            record.report?.result === null || record.report?.result === undefined
              ? []
              : [record.report.result],
          );
          const late = records.filter(
            ([, record]) =>
              record.role !== "auditor" && record.report !== null && !record.collected,
          );
          if (audits.length === 0 && late.length === 0) return;
          // Tasks handed out in one lead turn come back as one follow-up: the last of them to end
          // flushes again, so the lead wakes once for the batch instead of once per task.
          if (audits.length === 0) {
            for (const [, record] of records) {
              if (
                record.role !== "auditor" &&
                record.leadTurnId !== null &&
                late.some(([, done]) => done.leadTurnId === record.leadTurnId) &&
                (yield* stillRunning(record))
              )
                return;
            }
          }
          const plan = planFollowUp({
            current: followUpRound(yield* latestUserText(leadId)),
            audits: crewOff ? [] : audits,
            crewOff,
            results: late.map(([, record]) => ({
              role: record.role,
              subject: record.subject,
              status: record.report?.status ?? "completed",
              report: record.report?.result ?? null,
              proof: record.report?.proof && proofLabel(record.report.proof.verdict),
            })),
          });
          if (plan.prompt === null) {
            // The follow-up cap swallowed these reports; the lead still hears that work came
            // back unfinished (crew off means the user ended the loop deliberately).
            const droppedUnfinished = crewOff
              ? []
              : late.filter(([, record]) =>
                  ["partial", "blocked", "failed"].includes(record.report?.status ?? "completed"),
                );
            for (const [taskId, record] of late) {
              yield* markCollected(taskId, record, { dropped: true });
            }
            if (!crewOff) {
              for (const [, record] of auditRecords) {
                yield* updateTask(record, { auditState: "skipped" });
              }
            }
            if (droppedUnfinished.length > 0) {
              yield* appendActivity({
                threadId: leadId,
                kind: CREW_RESULTS_DROPPED_ACTIVITY,
                summary: `Crew left work unfinished: ${reportExcerpt(
                  droppedUnfinished.map(([, record]) => record.subject).join(", "),
                )}`,
                turnId: droppedUnfinished.at(-1)?.[1].leadTurnId ?? null,
                payload: {
                  tasks: droppedUnfinished.map(([taskId, record]) => ({
                    taskId,
                    crewRole: record.role,
                    subject: record.subject,
                    status: record.report?.status ?? "completed",
                  })),
                },
              });
            }
            return;
          }
          const createdAt = yield* nowIso;
          const deliveryId = yield* uuid;
          const data: typeof CrewFollowUpRecoveryJson.Type = {
            version: 1,
            taskIds: late.map(([taskId]) => taskId),
            auditTaskIds: crewOff ? [] : auditRecords.map(([taskId]) => taskId),
            command: {
              type: "thread.turn.start",
              commandId: CommandId.make(`server:crew-follow-up:${deliveryId}`),
              threadId: leadId,
              message: {
                messageId: MessageId.make(yield* uuid),
                role: "user",
                text: plan.prompt,
                attachments: [],
              },
              runtimeMode: lead.value.runtimeMode,
              interactionMode: lead.value.interactionMode,
              createdAt,
            },
          };
          const recordJson = yield* encodeFollowUpRecovery(data).pipe(
            Effect.mapError(() => new CrewError({ reason: "Could not encode crew delivery." })),
          );
          const checkpoint: CrewFollowUpCheckpoint = {
            delivery_id: deliveryId,
            lead_thread_id: leadId,
            command_id: data.command.commandId,
            message_id: data.command.message.messageId,
            record_json: recordJson,
            created_at: createdAt,
            delivered_at: null,
            rejected_at: null,
          };
          yield* recovery.prepareFollowUp(checkpoint);
          yield* engine.dispatch(data.command);
          yield* finishFollowUp(checkpoint, data);
          yield* appendActivity({
            threadId: leadId,
            kind: "crew.follow-up",
            summary: "OOP Crew sent the lead a follow-up turn",
            turnId: lead.value.latestTurn?.turnId ?? null,
            payload: { reason: audits.length > 0 ? "audit" : "results", results: late.length },
          });
        }),
      )
      .pipe(Effect.catchCause((cause) => Effect.logWarning("crew follow-up skipped", { cause })));

  /** Only a thread that leads a crew task can have a delivery waiting, so no other one takes the lock. */
  const flushFollowUps = (leadId: ThreadId): Effect.Effect<void> =>
    leadIds.has(leadId) ? flushLead(leadId) : Effect.void;
  /**
   * Ends a task's run: `over` resolves, and a run that broke off without a report flushes its
   * lead, since a report of the same lead turn may be held for it.
   */
  const endRun = (record: CrewTaskRecord) =>
    Deferred.succeed(record.over, undefined).pipe(
      Effect.andThen(
        Effect.suspend(() =>
          record.report === null ? flushFollowUps(record.leadThreadId) : Effect.void,
        ),
      ),
    );

  /** The directory the lead works in, which a shared task works in too. */
  const workspaceCwd = (lead: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const project =
        lead.worktreePath === null
          ? yield* snapshots.getProjectShellById(lead.projectId)
          : Option.none();
      return (
        lead.worktreePath ?? Option.getOrNull(Option.map(project, (shell) => shell.workspaceRoot))
      );
    });

  /**
   * The model and family of each task a new one must differ from. A task's model is what it runs
   * on now; after a restart that is read from the thread of its last attempt. A task id that is
   * not one of this lead's tasks refuses the delegation, since the lead named it on purpose.
   */
  const avoidedTasks = (
    lead: OrchestrationThreadShell,
    options: ReadonlyArray<CrewModelOption>,
    taskIds: ReadonlyArray<string>,
  ) =>
    Effect.gen(function* () {
      const avoided: AvoidedTask[] = [];
      for (const taskId of new Set(taskIds)) {
        const record = tasks.get(taskId);
        if (record === undefined || record.leadThreadId !== lead.id) {
          return yield* fail(`differentFrom: ${taskId} is not one of your crew tasks.`);
        }
        const threadId = lastRunThreadId(record);
        const selection =
          record.chosen ??
          (threadId === undefined
            ? undefined
            : Option.getOrUndefined(yield* shellOf(threadId))?.modelSelection);
        if (selection === undefined) continue;
        const driver =
          options.find(
            (option) =>
              option.selection.instanceId === selection.instanceId &&
              option.selection.model === selection.model,
          )?.driver ?? selection.instanceId;
        avoided.push({ taskId, selection, family: familyOf(driver, selection) });
      }
      return avoided;
    });

  /** A worktree for an isolated task, or none when the lead's workspace cannot give it one. */
  const isolate = (lead: OrchestrationThreadShell, taskId: string) =>
    Effect.gen(function* () {
      const cwd = yield* workspaceCwd(lead);
      return cwd === null ? undefined : yield* worktrees.create({ taskId, cwd });
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("crew worktree could not be created", { error }).pipe(
          Effect.as(undefined),
        ),
      ),
    );

  /**
   * Applies an isolated member's changes to the lead's workspace once its turn ended. A note for
   * the report comes back when they could not be applied and the worktree was kept.
   */
  const mergeIsolated = (record: CrewTaskRecord) =>
    Effect.gen(function* () {
      if (record.worktree === undefined) return null;
      // A deleted lead has no workspace to take the changes.
      if (record.stopped === DELETED_LEAD) {
        yield* worktrees.discard(record.worktree);
        return null;
      }
      // A candidate is never applied: the lead picks from the kept patches.
      if (record.candidate === true) {
        const kept = yield* worktrees.keep(record.worktree);
        return kept.kept ? candidateNote(record.worktree, kept) : null;
      }
      const result = yield* worktrees.mergeBack(record.worktree);
      return result.merged ? null : mergeConflictNote(record.worktree, result);
    });

  /** Whether `mergeIsolated`'s note means the member's changes did not reach the workspace. */
  const leftOut = (record: CrewTaskRecord, note: string | null) =>
    note !== null && record.candidate !== true;

  /** A task that produced no usable result leaves the lead's workspace alone. */
  const dropIsolated = (record: CrewTaskRecord) =>
    record.worktree === undefined ? Effect.void : worktrees.discard(record.worktree);

  /** Whether this member's provider is on the build-time allow list for project memory. */
  const memoryAllowed = (option: CrewModelOption) =>
    memoryGate.driverAllowed(ProviderDriverKind.make(option.driver));

  /** The memories to attach for this member: the task's, only when its provider may receive them. */
  const memoryFor = (record: CrewTaskRecord, option: CrewModelOption) =>
    record.memory !== undefined && record.memory.length > 0 && memoryAllowed(option)
      ? record.memory
      : undefined;

  const memoryBlocked = (record: CrewTaskRecord, option: CrewModelOption) =>
    record.memory !== undefined && record.memory.length > 0 && !memoryAllowed(option);

  /**
   * The project memories the lead's current turn selected: the references on its latest user
   * message, by id and version. Nothing is forwarded while the lead thread is held for a changed
   * memory, since the member's send would be held the same way.
   */
  const leadMemory = (lead: OrchestrationThreadShell) =>
    Effect.gen(function* () {
      const detail = yield* snapshots
        .getThreadDetailById(lead.id)
        .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
      if (Option.isNone(detail))
        return { refs: [] as ReadonlyArray<CrewMemoryRef>, held: false, dropped: 0 };
      const message = detail.value.messages.findLast((entry) => entry.role === "user");
      if (message === undefined)
        return { refs: [] as ReadonlyArray<CrewMemoryRef>, held: false, dropped: 0 };
      const resolved = resolveProjectMemoryReferences({
        text: message.text,
        records: message.context?.records ?? [],
      });
      if (!resolved.ok || resolved.items.length === 0) {
        return { refs: [] as ReadonlyArray<CrewMemoryRef>, held: false, dropped: 0 };
      }
      if (Option.isSome(yield* memoryGate.threadHold(lead.id))) {
        return { refs: [] as ReadonlyArray<CrewMemoryRef>, held: true, dropped: 0 };
      }
      // Only what the ledger shows this message really sent to the lead may go on: a reference
      // the lead's own send dropped or never committed is not the member's to receive.
      const sent = yield* memoryGate.sentForMessage({
        threadId: lead.id,
        projectId: lead.projectId,
        messageId: message.id,
      });
      const refs = resolved.items.filter((item) =>
        sent.some((row) => row.memoryId === item.memoryId && row.version === item.selectedVersion),
      );
      return {
        refs: refs as ReadonlyArray<CrewMemoryRef>,
        held: false,
        // What the lead selected but the ledger does not show as sent: not the member's to get.
        dropped: resolved.items.length - refs.length,
      };
    });

  /**
   * Runs one crew task down its fallback chain. A model that fails hands the same task to the
   * next model in the chain; the lead's board shows each switch, and the brain only takes the
   * task back once every model has failed. A task the user interrupts is not retried.
   */
  const runTask = (input: {
    readonly lead: OrchestrationThreadShell;
    /** The lead's reason for the task, shown once on its `task.started` activity. */
    readonly why?: string | undefined;
    readonly taskId: string;
    readonly record: CrewTaskRecord;
    readonly chain: ReadonlyArray<CrewModelOption>;
    readonly subject: string;
    readonly prompt: string;
    readonly leadTurnId: TurnId | null;
  }) =>
    Effect.gen(function* () {
      const { record } = input;
      const label = CREW_ROLE_LABEL[record.role];
      const base = {
        taskId: input.taskId,
        title: input.subject,
        agentKind: "agent",
        crewRole: record.role,
      };
      const finish = (report: Omit<CrewTaskReport, "taskId" | "role">) =>
        Effect.gen(function* () {
          const result = { taskId: input.taskId, role: record.role, ...report };
          yield* updateTask(record, { report: result });
          yield* Deferred.succeed(record.done, undefined);
        });

      const skipped: string[] = [];
      for (const option of input.chain) {
        // A stopped task is never handed to another model.
        if (record.stopped !== undefined) break;
        // The first attempt ignores cooling; from the second on, a cooling provider is skipped,
        // and so is a model the provider refused, and the switch message says why.
        if (record.attempts.length > 0) {
          const state = yield* cooling;
          const modelNote = state.modelNotes.get(modelKey(option.selection));
          if (modelNote !== undefined) {
            skipped.push(modelNote);
            continue;
          }
          const note = state.notes.get(option.selection.instanceId);
          if (note !== undefined) {
            skipped.push(note);
            continue;
          }
        }
        const previous = record.attempts.at(-1);
        // A model that takes over mid-task is told which TODO items the earlier one finished.
        const resumed =
          lastRunThreadId(record) !== undefined &&
          (record.todos?.some((todo) => todo.status !== "pending") === true ||
            (record.queued?.length ?? 0) > 0);
        const attempt: CrewAttempt = { model: `${option.label} (${option.providerLabel})` };
        attempt.threadId = ThreadId.make(yield* uuid);
        attempt.messageId = MessageId.make(yield* uuid);
        record.attempts.push(attempt);
        record.chosen = option.selection;
        // The next model's prompt lists the whole checklist, so nothing is left to deliver.
        if (resumed) record.queued = [];
        record.live = {
          threadId: attempt.threadId,
          model: option.label,
          providerInstanceId: option.selection.instanceId,
        };
        yield* persistTask(record);
        yield* appendActivity({
          threadId: input.lead.id,
          kind: previous === undefined ? "task.started" : "task.progress",
          summary:
            previous === undefined
              ? `${label} started: ${input.subject}`
              : `${label} switched to ${option.label}: ${input.subject}`,
          turnId: input.leadTurnId,
          payload: {
            ...base,
            // The board opens or stops this attempt's own thread.
            threadId: attempt.threadId,
            model: option.label,
            // Clients color the task by the provider instance running this attempt.
            providerInstanceId: option.selection.instanceId,
            status: "running",
            ...(previous === undefined && input.why !== undefined ? { why: input.why } : {}),
            ...(previous === undefined
              ? {}
              : {
                  summary: reportExcerpt(
                    `${previous.model} failed (${previous.error ?? "failed"}); retrying with ${option.label}.${
                      skipped.length === 0 ? "" : ` ${skipped.join("; ")}.`
                    }${
                      memoryBlocked(record, option)
                        ? " Project memory is not sent to this model."
                        : ""
                    }`,
                  ),
                }),
          },
        });
        // Each switch message names only the skips since the attempt before it.
        skipped.length = 0;
        if (previous === undefined) yield* emitProgress(record);
        // Every crew session is a provider process; wait for room under the live-session budget.
        // The wait is capped, so a full house of leads waiting on crew_wait cannot deadlock.
        if (Option.isSome(capacity)) {
          let queued = false;
          yield* capacity.value.admitCrew({
            onWait: Effect.suspend(() => {
              queued = true;
              return emitProgress(record, "running", "waiting for capacity").pipe(Effect.ignore);
            }),
          });
          // The queued row would otherwise stay until the next checklist change.
          if (queued) yield* emitProgress(record, "running", "started").pipe(Effect.ignore);
        }
        const launched = yield* Effect.exit(
          launchCrewThread({
            threadId: attempt.threadId,
            messageId: attempt.messageId,
            lead: input.lead,
            role: record.role,
            option,
            subject: input.subject,
            prompt: resumed
              ? [input.prompt, ...todoResumeLines(record.todos)].join("\n")
              : input.prompt,
            worktree: record.worktree,
            memory: memoryFor(record, option),
          }),
        );
        if (Exit.isFailure(launched)) {
          attempt.error = "could not start";
          yield* persistTask(record);
          yield* markFailed(option.selection, attempt.error);
          continue;
        }
        const threadId = launched.value;
        attempt.threadId = threadId;
        // A stop that came while the thread was being created had nothing to interrupt yet.
        if (record.stopped !== undefined) yield* interruptMember(record);
        const first = yield* settled(threadId, attempt.messageId);
        if (first.held !== null) record.held = first.held;
        const nudged = yield* nudgePending({
          lead: input.lead,
          record,
          threadId,
          status: first.status,
        });
        const delivered = yield* deliverAdded({
          lead: input.lead,
          record,
          threadId,
          status: nudged,
        });
        // A held message started no turn. Another model would be handed the same memory, so the
        // task ends blocked and the lead decides.
        if (record.held !== undefined && record.stopped === undefined) {
          const reply = yield* lastAssistantText(threadId);
          if (reply === null) yield* dropIsolated(record);
          const kept = reply === null ? null : yield* mergeIsolated(record);
          const blocked = `Blocked: the member's message was held and no turn started (${record.held}). Do not copy project memory into the task; resend after the memory settles, or ask the user.`;
          const heldProof = proofOf(record, "blocked", false, undefined);
          yield* finish({
            status: "blocked",
            result: withNote(
              withNote(
                withNote(
                  reply === null
                    ? blocked
                    : `${blocked}\n\n${clipCrewReport(reply, RESULT_TEXT_LIMIT)}`,
                  todoNoteOf(record),
                ),
                proofLine(heldProof, "blocked"),
              ),
              kept,
            ),
            ...(heldProof === null ? {} : { proof: heldProof }),
          });
          yield* appendActivity({
            threadId: input.lead.id,
            kind: "task.completed",
            summary: `${label} is blocked on: ${input.subject}`,
            turnId: input.leadTurnId,
            payload: {
              ...base,
              threadId,
              model: option.label,
              status: "blocked",
              ...(heldProof === null ? {} : { proof: heldProof.verdict }),
              ...todoPayload(record),
              summary: reportExcerpt(blocked),
            },
          });
          yield* updateTask(record, { ended: true });
          yield* settleThread(threadId);
          yield* flushFollowUps(record.leadThreadId);
          return;
        }
        // The turn an interrupt cut short may end as an error; it is still a stop, not a failure.
        const status =
          record.stopped !== undefined && delivered === "failed" ? "interrupted" : delivered;
        // Status and verdict are judged on the full report; only the stored result is clipped.
        const reply = yield* lastAssistantText(threadId);
        if (status === "completed" || status === "interrupted") {
          if (status === "completed") markWorked(option.selection);
          // The checks run in the task's workspace, which merging an isolated one removes.
          if (status === "completed") yield* sweepTodos(record);
          const stoppedNow = record.stopped !== undefined && status === "interrupted";
          const { status: memberStatus, report } = crewMemberOutcome(
            record.role,
            status,
            reply,
            record.todos === undefined ? undefined : todoCounts(record.todos),
          );
          const kept = yield* mergeIsolated(record);
          // Changes that did not reach the workspace leave the task unfinished.
          const outcome: CrewTaskOutcome =
            leftOut(record, kept) && memberStatus === "completed" ? "partial" : memberStatus;
          const { evidence, testsPassed } = yield* completionEvidence(
            threadId,
            record.role,
            report ?? undefined,
          );
          const proof = proofOf(record, outcome, testsPassed, report ?? undefined);
          yield* finish({
            status: outcome,
            result: withNote(
              withNote(
                withNote(
                  stoppedNow
                    ? (record.stopped ?? null)
                    : reply === null
                      ? null
                      : clipCrewReport(reply, RESULT_TEXT_LIMIT),
                  todoNoteOf(record),
                ),
                proofLine(proof, outcome),
              ),
              kept,
            ),
            ...(report === null ? {} : { report }),
            ...(proof === null ? {} : { proof }),
          });
          if (record.role === "auditor" && status === "completed")
            yield* queueAuditFix(record, reply);
          yield* appendActivity({
            threadId: input.lead.id,
            kind: "task.completed",
            summary: `${label} ${outcome === "completed" ? "finished" : outcome === "partial" ? "finished part of" : outcome === "blocked" ? "is blocked on" : "stopped"}: ${input.subject}`,
            turnId: input.leadTurnId,
            payload: {
              ...base,
              threadId,
              ...evidence,
              model: option.label,
              status: outcome === "interrupted" ? "stopped" : outcome,
              ...(proof === null ? {} : { proof: proof.verdict }),
              ...todoPayload(record),
              ...(stoppedNow
                ? { summary: record.stopped }
                : reply === null
                  ? {}
                  : { summary: reportExcerpt(reply) }),
              // Thread goals read the verdict to wait for an approving audit.
              ...(record.role === "auditor" ? { verdict: auditVerdict(reply) } : {}),
            },
          });
          yield* updateTask(record, { ended: true });
          yield* settleThread(threadId);
          // The user or the lead asked for the stop, so the report is not handed back as news.
          // A result that arrived whole is news for the lead when the stop was only a request;
          // a stop with the lead's own turn must not start that lead again to hand it over.
          if (
            record.stopped !== undefined &&
            !(status === "completed" && record.stopped === STOPPED_ON_REQUEST)
          )
            yield* markCollected(input.taskId, record, { stopped: true });
          yield* flushFollowUps(record.leadThreadId);
          return;
        }
        attempt.error = (yield* lastErrorOf(threadId)) ?? "the turn failed";
        yield* persistTask(record);
        yield* markFailed(option.selection, attempt.error);
        yield* settleThread(threadId);
      }

      if (record.stopped !== undefined) {
        // Stopped between models: nothing is running, so the stop is the whole ending.
        yield* dropIsolated(record);
        const stoppedProof = proofOf(record, "interrupted", false, undefined);
        yield* finish({
          status: "interrupted",
          result: withNote(
            withNote(record.stopped, todoNoteOf(record)),
            proofLine(stoppedProof, "interrupted"),
          ),
          ...(stoppedProof === null ? {} : { proof: stoppedProof }),
        });
        yield* appendActivity({
          threadId: input.lead.id,
          kind: "task.completed",
          summary: `${label} stopped: ${input.subject}`,
          turnId: input.leadTurnId,
          payload: {
            ...base,
            ...(lastRunThreadId(record) === undefined ? {} : { threadId: lastRunThreadId(record) }),
            status: "stopped",
            ...(stoppedProof === null ? {} : { proof: stoppedProof.verdict }),
            ...todoPayload(record),
            summary: record.stopped,
          },
        });
        yield* updateTask(record, { ended: true });
        yield* markCollected(input.taskId, record, { stopped: true });
        yield* flushFollowUps(record.leadThreadId);
        return;
      }

      const report = crewExhaustedReport(record.role, record.attempts);
      yield* dropIsolated(record);
      const failedProof = proofOf(record, "failed", false, undefined);
      yield* finish({
        status: "failed",
        result: report,
        ...(failedProof === null ? {} : { proof: failedProof }),
      });
      yield* appendActivity({
        threadId: input.lead.id,
        kind: "task.completed",
        summary: `${label} failed on every crew model; the lead takes it: ${input.subject}`,
        turnId: input.leadTurnId,
        payload: {
          ...base,
          // The last model that actually ran, so the board can open its thread.
          ...(lastRunThreadId(record) === undefined ? {} : { threadId: lastRunThreadId(record) }),
          status: "failed",
          ...(failedProof === null ? {} : { proof: failedProof.verdict }),
          ...todoPayload(record),
          summary: reportExcerpt(report),
        },
      });
      yield* updateTask(record, { ended: true });
      yield* flushFollowUps(record.leadThreadId);
    });

  const startTask = Effect.fn("CrewService.startTask")(function* (input: {
    readonly lead: OrchestrationThreadShell;
    readonly role: CrewRole;
    readonly resolved: ResolvedCrew;
    readonly options: ReadonlyArray<CrewModelOption>;
    readonly subject: string;
    readonly prompt: string;
    readonly leadTurnId: TurnId | null;
    readonly why?: string | undefined;
    /** The lead's own crew_delegate call; one from a stopped lead turn starts stopped. */
    readonly fromLeadCall?: boolean;
    readonly writeScope?: ReadonlyArray<string> | undefined;
    readonly isolation?: "shared" | "worktree" | "candidate" | undefined;
    /** Earlier tasks whose model family this one keeps away from. */
    readonly avoid?: ReadonlyArray<AvoidedTask> | undefined;
    /** The checklist, numbered by the server; the task starts with every item pending. */
    readonly todos?: ReadonlyArray<TodoItem> | undefined;
    /** Run the task on the cheapest model available instead of the role's own, unless the user pinned that role's model. */
    readonly preferFast?: boolean;
    /** The lead's selected project memories, passed on by id and version. */
    readonly memory?: ReadonlyArray<CrewMemoryRef> | undefined;
  }) {
    const brain = input.lead.modelSelection;
    const coolingState = yield* cooling;
    // Only the role's own model is tried while cooling; OOP's fast pick skips what is cooling.
    const fastest =
      input.preferFast === true && !input.resolved.pinned.has(input.role)
        ? (input.options.find(
            (option) =>
              option.tier === 1 &&
              !coolingState.providers.has(option.selection.instanceId) &&
              !coolingState.modelNotes.has(modelKey(option.selection)) &&
              (brain === null ||
                option.selection.instanceId !== brain.instanceId ||
                option.selection.model !== brain.model),
          ) ?? null)
        : null;
    const chain = crewFallbackChain({
      options: input.options,
      role: input.role,
      assigned: fastest ?? input.resolved.roles[input.role],
      // The user's fallback models come before OOP's own picks.
      fallbacks: input.resolved.fallbacks[input.role],
      preset: input.resolved.preset,
      brain: input.lead.modelSelection,
      unavailableInstances: coolingState.providers,
      unavailableModels: coolingState.models,
      ...(input.avoid === undefined || input.avoid.length === 0
        ? {}
        : {
            avoidFamilies: new Set(input.avoid.map((task) => task.family)),
            avoidSelections: input.avoid.map((task) => task.selection),
          }),
    });
    const stopsBefore = leadStops.get(input.lead.id)?.count ?? 0;
    const stoppedAtStart = () => {
      const stop = leadStops.get(input.lead.id);
      if ((stop?.count ?? 0) !== stopsBefore) return stop?.reason;
      // Only the lead's own tool call is bound to its turn; a user's retry is a new decision.
      return input.fromLeadCall === true &&
        input.leadTurnId !== null &&
        isStoppedLeadTurn(input.lead.id, input.leadTurnId)
        ? (stop?.reason ?? STOPPED_WITH_LEAD)
        : undefined;
    };
    const first = chain[0];
    if (first === undefined) {
      return yield* fail(
        `No model is available for the ${CREW_ROLE_LABEL[input.role].toLowerCase()} role. Do the work yourself.`,
      );
    }
    const taskId = yield* uuid;
    const worktree =
      input.isolation === "worktree" || input.isolation === "candidate"
        ? yield* isolate(input.lead, taskId)
        : undefined;
    // Explicit isolation must never write straight into the lead's shared workspace.
    if (
      (input.isolation === "candidate" || input.isolation === "worktree") &&
      worktree === undefined
    ) {
      return yield* fail(
        `${input.isolation === "candidate" ? "A candidate" : "Worktree isolation"} needs its own git worktree, but one could not be created (the workspace is not a git repository with a commit, or git failed). Do not start it in the shared workspace.`,
      );
    }
    const todos = input.todos === undefined || input.todos.length === 0 ? undefined : input.todos;
    // File checks and scope reports compare the workspace with how it was right now.
    const todoCwd =
      todos === undefined
        ? null
        : (worktree?.cwd ??
          (yield* workspaceCwd(input.lead).pipe(Effect.orElseSucceed(() => null))));
    const comparesFiles =
      todos?.some((todo) => todo.check?.files !== undefined) === true ||
      (input.writeScope?.length ?? 0) > 0;
    const tree = todoCwd !== null && comparesFiles ? yield* todoChecks.snapshot(todoCwd) : null;
    const hashes =
      todoCwd !== null && comparesFiles && tree === null
        ? yield* todoChecks.hashFiles(
            todoCwd,
            todos?.flatMap((todo) => todo.check?.files ?? []) ?? [],
          )
        : undefined;
    const record: CrewTaskRecord = {
      taskId,
      leadThreadId: input.lead.id,
      leadTurnId: input.leadTurnId,
      role: input.role,
      subject: input.subject,
      writeScope: input.writeScope,
      worktree,
      ...(input.isolation === "candidate" ? { candidate: true } : {}),
      chosen: first.selection,
      todos: todos === undefined ? undefined : [...todos],
      todoBase:
        todoCwd === null
          ? undefined
          : { cwd: todoCwd, tree, ...(hashes === undefined ? {} : { hashes }) },
      attempts: [],
      // Set when a stop of the whole lead came while this task was being set up, or when the
      // lead turn that hands it over was already stopped (a late tool call from that turn).
      stopped: stoppedAtStart(),
      memory: input.memory,
      why: input.why,
      report: null,
      collected: false,
      ended: false,
      auditState: "none",
      done: yield* Deferred.make<void>(),
      over: yield* Deferred.make<void>(),
      lock: yield* Semaphore.make(1),
      checkLock: yield* Semaphore.make(1),
    };
    yield* persistTask(record);
    tasks.set(taskId, record);
    leadIds.add(record.leadThreadId);
    // A stop that landed after the record was built but before it was listed found nothing to
    // stop; this is the first moment the record can be marked.
    const late = stoppedAtStart();
    if (record.stopped === undefined && late !== undefined)
      yield* updateTask(record, { stopped: late });
    yield* runTask({
      ...input,
      prompt:
        worktree === undefined
          ? input.prompt
          : `${input.prompt}\n\n${input.isolation === "candidate" ? CANDIDATE_CHECKOUT_PROMPT : ISOLATED_CHECKOUT_PROMPT}`,
      taskId,
      record,
      chain,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("crew task stopped", { cause });
          if (record.ended) return;
          if (record.report === null) yield* dropIsolated(record);
          yield* endBrokenTask({
            lead: input.lead,
            leadTurnId: input.leadTurnId,
            taskId,
            role: input.role,
            subject: input.subject,
            summary: `${CREW_ROLE_LABEL[input.role]} stopped: ${input.subject}`,
            todos: todoPayload(record),
          });
        }),
      ),
      Effect.ensuring(endRun(record)),
      Effect.forkIn(watcherScope),
    );
    return {
      taskId,
      model: `${first.label} (${first.providerLabel})`,
      isolated: worktree !== undefined,
      memoryBlocked: memoryBlocked(record, first),
      // The earlier tasks this one shares a model family with, when none could be avoided.
      sharesFamilyWith: (input.avoid ?? [])
        .filter((task) => task.family === familyOf(first.driver, first.selection))
        .map((task) => task.taskId),
    };
  });

  const requireLead = Effect.fn("CrewService.requireLead")(function* (threadId: ThreadId) {
    const lead = yield* shellOf(threadId);
    if (Option.isNone(lead)) return yield* fail("This thread is not available.");
    if (isCrewThreadTitle(lead.value.title)) {
      return yield* fail("Crew threads do their task themselves; they cannot hand work on.");
    }
    return lead.value;
  });

  const roster: CrewService["Service"]["roster"] = Effect.fn("CrewService.roster")(
    function* (threadId) {
      const lead = yield* requireLead(threadId);
      const { resolved, canLead } = yield* crewFor(lead);
      const { entries } = yield* cooling;
      return {
        enabled: resolved.enabled && canLead,
        roles: (["worker", "expert", "auditor"] as const).map((role) => ({
          role,
          model: resolved.roles[role]?.label ?? null,
          provider: resolved.roles[role]?.providerLabel ?? null,
          ...(resolved.fallbacks[role].length === 0
            ? {}
            : {
                fallbacks: resolved.fallbacks[role].map((option) => ({
                  model: option.label,
                  provider: option.providerLabel,
                })),
              }),
        })),
        cooling: [...entries],
      };
    },
  );

  const delegate: CrewService["Service"]["delegate"] = Effect.fn("CrewService.delegate")(
    function* (input) {
      const lead = yield* requireLead(input.threadId);
      const { resolved, options, canLead } = yield* crewFor(lead);
      if (!canLead) return yield* fail(CREW_LEAD_REFUSAL);
      if (!resolved.enabled) {
        return yield* fail("OOP Crew is off for this thread. Do the work yourself.");
      }
      if (
        resolved.roles.worker === null &&
        resolved.roles.expert === null &&
        resolved.roles.auditor !== null
      ) {
        return yield* fail(
          `Only the auditor is set (${resolved.roles.auditor.label}): there is no worker or expert to delegate to. The auditor reviews file-changing turns on its own. Do the work yourself.`,
        );
      }
      const task = input.task.trim();
      if (task.length === 0) return yield* fail("Describe the task to hand over.");
      const writeScope = input.writeScope?.map((path) => path.trim()).filter((path) => path !== "");
      const todos = assignTodos(input.todos);
      const memory = yield* leadMemory(lead);
      const avoid = yield* avoidedTasks(lead, options, input.differentFrom ?? []);
      const subject = input.title?.trim() || task;
      // What this lead's earlier tasks made of the same work, so the prompt can hand it on; read
      // before startTask, so the list holds only the tasks that came before this one. A task meant
      // to judge independently (differentFrom, an arena candidate) is not told the earlier result.
      const independent = (input.differentFrom?.length ?? 0) > 0 || input.isolation === "candidate";
      const prior: PriorCrewTask[] = [];
      for (const record of tasks.values()) {
        if (independent || record.leadThreadId !== lead.id || record.role === "auditor") continue;
        prior.push({
          taskId: record.taskId,
          subject: record.subject,
          // A run that broke off without a report is over, not running.
          report:
            record.report ??
            ((yield* stillRunning(record)) ? null : { status: "failed", result: null }),
          lastError: record.attempts.at(-1)?.error,
          stopped: record.stopped,
        });
      }
      const repeat = previousAttemptOf(subject, prior);
      const {
        isolated,
        memoryBlocked: memoryNotSent,
        sharesFamilyWith,
        ...started
      } = yield* startTask({
        lead,
        role: input.role,
        resolved,
        options,
        subject,
        prompt: delegatePrompt({
          role: input.role,
          leadTitle: lead.title,
          task,
          previous: repeat !== null && repeat.kind === "unfinished" ? repeat.previous : undefined,
          writeScope,
          verify: input.verify,
          doneWhen: input.doneWhen,
          todos,
        }),
        leadTurnId: lead.latestTurn?.turnId ?? null,
        fromLeadCall: true,
        writeScope,
        isolation: input.isolation,
        preferFast: input.size === "small",
        avoid,
        todos,
        memory: memory.refs,
        why: cleanWhy(input.why),
      });
      // Tasks without a scope are unknown, so they stay out of the comparison, as do isolated
      // ones: a task in its own worktree neither clobbers nor is clobbered.
      const overlap = isolated
        ? null
        : writeScopeWarning(
            overlappingWriteScopes(
              writeScope ?? [],
              [...tasks.values()]
                .filter(
                  (record) =>
                    record.leadThreadId === lead.id &&
                    record.report === null &&
                    record.taskId !== started.taskId,
                )
                .map((record) => ({
                  taskId: record.taskId,
                  subject: record.subject,
                  writeScope: record.writeScope,
                  isolated: record.worktree !== undefined,
                })),
            ),
          );
      const warning = [
        todos.some((todo) => todo.check !== undefined)
          ? null
          : "No todo has a check; OOP will not be able to verify this task.",
        memoryNotSent
          ? `Project memory you selected this turn was not sent to ${started.model}: its provider does not support project memory yet. Do not copy project memory content into the task; use a member whose provider supports project memory, or ask the user.`
          : null,
        memory.held
          ? "Project memory you selected this turn changed since you sent it, so it was not passed on."
          : null,
        memory.dropped > 0
          ? `${memory.dropped} of the ${memory.dropped + memory.refs.length} project memories you selected this turn were not passed to the member: they were not sent with your message. Do not copy their content into the task; ask the user if the member needs them.`
          : null,
        sharesFamilyWith.length > 0
          ? `No model from another family is available; this task shares a family with ${sharesFamilyWith.join(", ")}, so treat its judgment as not independent.`
          : null,
        overlap,
        repeat === null ? null : repeatTaskWarning(repeat),
      ]
        .filter((line) => line !== null)
        .join("\n");
      return {
        ...started,
        ...(todos.length === 0 ? {} : { todos: todos.map(({ id, text }) => ({ id, text })) }),
        ...(warning === "" ? {} : { warning }),
      };
    },
  );

  const addTodos: CrewService["Service"]["addTodos"] = Effect.fn("CrewService.addTodos")(
    function* (input) {
      const lead = yield* requireLead(input.threadId);
      const record = tasks.get(input.taskId);
      if (record === undefined || record.leadThreadId !== lead.id) {
        return yield* fail("This is not one of your crew tasks.");
      }
      return yield* record.checkLock.withPermits(1)(
        Effect.gen(function* () {
          if (record.closed === true || record.report !== null) {
            return yield* fail(
              "This task has finished, so its list is closed. Delegate the extra work as a new task with crew_delegate.",
            );
          }
          const existing = record.todos ?? [];
          const { items, count, room } = appendTodos(existing, input.todos);
          if (count === 0) return yield* fail("Give at least one item with some text.");
          if (items.length === 0) {
            return yield* fail(
              `A task's list holds at most ${CREW_TODO_MAX} items and this one has ${existing.length}, so there is room for ${room}. Delegate the rest as a new task.`,
            );
          }
          if (record.todoBase === undefined && items.some((item) => item.check !== undefined)) {
            return yield* fail(
              "This task started without a checklist, so it has no workspace to run checks in. Add the items as plain text.",
            );
          }
          yield* updateTask(record, {
            todos: [...existing, ...items],
            queued: [...(record.queued ?? []), ...items.map((item) => item.id)],
          });
          yield* emitProgress(record);
          return {
            todos: items.map(({ id, text }) => ({ id, text })),
            total: existing.length + items.length,
          };
        }),
      );
    },
  );

  /** The prompt a task's first crew thread was started with, or null once its threads are gone. */
  const originalPrompt = (record: CrewTaskRecord) =>
    Effect.gen(function* () {
      for (const attempt of record.attempts) {
        if (attempt.threadId === undefined || attempt.messageId === undefined) continue;
        const detail = yield* snapshots
          .getThreadDetailById(attempt.threadId)
          .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThread>()));
        const text = Option.isSome(detail)
          ? detail.value.messages.find((message) => message.id === attempt.messageId)?.text
          : undefined;
        if (text !== undefined) return withoutCrewMemoryReferences(text);
      }
      return null;
    });

  /**
   * Runs a task that ended without finishing again as a new task on the same lead turn, so the board
   * keeps both cards. The lead never waits on it; like any late crew result, its report reaches the
   * lead through flushFollowUps once the task ends and the lead is idle.
   */
  const retryTask: CrewService["Service"]["retryTask"] = Effect.fn("CrewService.retryTask")(
    function* (input) {
      const lead = yield* requireLead(input.threadId);
      const { resolved, options, canLead } = yield* crewFor(lead);
      if (!canLead) return yield* fail(CREW_LEAD_REFUSAL);
      if (!resolved.enabled) return yield* fail("OOP Crew is off for this thread.");
      const record = tasks.get(input.taskId);
      if (record === undefined || record.leadThreadId !== lead.id) {
        return yield* fail("This crew task is not available to retry.");
      }
      if (record.role === "auditor") {
        return yield* fail("An audit runs again when the lead changes files.");
      }
      if (record.report === null || record.report.status === "completed") {
        return yield* fail("Only a task that ended without finishing can be retried.");
      }
      const original = yield* originalPrompt(record);
      if (original === null)
        return yield* fail("The task's original brief is no longer available.");
      // In the shared workspace the earlier attempt's changes are still there, so its finished
      // items stay finished and only the open ones start again from pending. A fresh worktree
      // does not have those changes (a failed task's was dropped, a candidate's is never
      // applied, and the record does not say whether a merge landed), so every item restarts.
      const finished = (todo: TodoItem) =>
        record.worktree === undefined && (todo.status === "verified" || todo.status === "claimed");
      const todos = record.todos?.map((todo) => (finished(todo) ? todo : resetTodos([todo])[0]!));
      // The same resume lines a failover model reads: they replace the list in the original brief.
      const prompt = todos?.some(finished)
        ? [original, ...todoResumeLines(todos)].join("\n")
        : original;
      return yield* startTask({
        lead,
        role: record.role,
        resolved,
        options,
        subject: record.subject,
        prompt,
        leadTurnId: record.leadTurnId,
        writeScope: record.writeScope,
        // A task that had its own worktree gets a fresh one; the old one is the earlier attempt's.
        isolation:
          record.worktree === undefined ? undefined : record.candidate ? "candidate" : "worktree",
        todos,
        memory: record.memory,
        why: record.why,
      }).pipe(Effect.map(({ taskId, model }) => ({ taskId, model })));
    },
  );

  /**
   * Stops the running tasks of one lead (`taskIds` narrows it). Each task records why it stopped
   * before its member is interrupted, so the member's cut-off turn, however it ends, finishes the
   * task as stopped instead of failing over to another model. The lead's `crew.stopped` activity
   * marks the end of the whole stop. Safe to call again: a task that is already stopping keeps its
   * first reason.
   */
  const stopTasks = (input: {
    readonly leadId: ThreadId;
    readonly reason: string;
    /** The lead's own reason for stopping, when it gave one. */
    readonly why?: string | undefined;
    readonly taskIds?: ReadonlyArray<string> | undefined;
  }) =>
    Effect.gen(function* () {
      // A task still being created is in no map yet; it reads this to learn it was stopped.
      if (input.taskIds === undefined) {
        leadStops.set(input.leadId, {
          count: (leadStops.get(input.leadId)?.count ?? 0) + 1,
          reason: input.reason,
        });
      }
      const targets = [...tasks.values()].filter(
        (record) =>
          record.leadThreadId === input.leadId &&
          record.report === null &&
          (input.taskIds === undefined || input.taskIds.includes(record.taskId)),
      );
      if (targets.length === 0) return { stopped: [], stopping: [] };
      for (const record of targets) {
        // The list is closed so a member cut off mid-turn cannot still verify items afterwards.
        record.closed = true;
        // A lead deleted after it was stopped upgrades the reason: its workspace is gone, so an
        // isolated task's work is discarded rather than merged.
        if (
          record.stopped === undefined ||
          (input.reason === DELETED_LEAD && record.stopped !== DELETED_LEAD)
        )
          yield* updateTask(record, { stopped: input.reason });
        yield* interruptMember(record);
        yield* emitProgress(record, "stopped");
      }
      yield* Effect.forEach(targets, (record) => Deferred.await(record.over), {
        concurrency: "unbounded",
        discard: true,
      }).pipe(Effect.timeoutOption(Duration.seconds(STOP_WAIT_SECONDS)));
      const taskIds = targets.map((record) => record.taskId);
      const stopping: string[] = [];
      for (const record of targets) {
        if (!(yield* Deferred.isDone(record.over))) stopping.push(record.taskId);
      }
      // A stop that is not over says so; `crew.stopped` marks only a stop that finished.
      yield* appendActivity(
        stopping.length === 0
          ? {
              threadId: input.leadId,
              kind: CREW_STOPPED_ACTIVITY,
              summary: `OOP Crew stopped ${taskIds.length === 1 ? "a task" : `${taskIds.length} tasks`}`,
              turnId: null,
              payload: {
                taskIds,
                reason: input.reason,
                ...(input.why === undefined ? {} : { why: input.why }),
              },
            }
          : {
              threadId: input.leadId,
              kind: CREW_STOPPING_ACTIVITY,
              summary: `OOP Crew is still stopping ${stopping.length === 1 ? "a task" : `${stopping.length} tasks`}`,
              turnId: null,
              payload: {
                taskIds,
                stopping,
                reason: input.reason,
                ...(input.why === undefined ? {} : { why: input.why }),
              },
            },
      );
      return {
        stopped: targets.flatMap((record) =>
          record.report?.status === "interrupted" ? [record.taskId] : [],
        ),
        stopping,
      };
    });

  const stop: CrewService["Service"]["stop"] = Effect.fn("CrewService.stop")(function* (input) {
    const lead = yield* requireLead(input.threadId);
    if (input.taskId !== undefined) {
      const record = tasks.get(input.taskId);
      if (record === undefined || record.leadThreadId !== lead.id) {
        return yield* fail("This crew task is not available to stop.");
      }
    }
    return yield* stopTasks({
      leadId: lead.id,
      reason: STOPPED_ON_REQUEST,
      why: cleanWhy(input.why),
      taskIds: input.taskId === undefined ? undefined : [input.taskId],
    });
  });

  const unknownTaskReport = (taskId: string): CrewTaskReport => ({
    taskId,
    role: null,
    status: "failed",
    result: "Unknown task id; it may be from before the server restarted.",
  });

  const wait: CrewService["Service"]["wait"] = Effect.fn("CrewService.wait")(function* (input) {
    // The client that called the tool decides how long one call may wait: a driver whose MCP
    // client tool-call timeout OOP sets itself may wait past the unknown-client cap, an unknown
    // or unproven one keeps the 50 second behaviour.
    const driver =
      input.providerInstanceId === undefined
        ? undefined
        : (yield* providers.getProviders).find(
            (provider) => provider.instanceId === input.providerInstanceId,
          )?.driver;
    const { capSeconds, defaultSeconds } = waitBounds(driver);
    const seconds = Math.min(Math.max(input.timeoutSeconds ?? defaultSeconds, 1), capSeconds);
    const records = input.taskIds.map((taskId) => [taskId, tasks.get(taskId)] as const);
    for (const [taskId, record] of records) {
      if (record !== undefined && record.leadThreadId !== input.threadId) {
        return yield* fail(`Task ${taskId} belongs to another thread.`);
      }
    }
    yield* Effect.forEach(
      records,
      ([, record]) => (record === undefined ? Effect.void : Deferred.await(record.done)),
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeoutOption(Duration.seconds(seconds)));
    return yield* Effect.forEach(records, ([taskId, record]) =>
      Effect.gen(function* () {
        if (record === undefined) {
          return unknownTaskReport(taskId);
        }
        if (record.report !== null) {
          yield* markCollected(taskId, record);
          const { result } = record.report;
          return result === null
            ? record.report
            : { ...record.report, result: clipLeadReport(result) };
        }
        const current = record.attempts.at(-1);
        return {
          taskId,
          role: record.role,
          status: current?.threadId === undefined ? "starting" : yield* statusOf(current.threadId),
          result: current === undefined ? null : `Working on ${current.model}.`,
        } satisfies CrewTaskReport;
      }),
    ).pipe(
      // A slow status lookup must not push the call past the MCP client's tool timeout;
      // an unreturned report stays uncollected for the next call.
      Effect.timeoutOrElse({
        duration: Duration.seconds(WAIT_COLLECT_SECONDS),
        orElse: () =>
          Effect.succeed(
            records.map(([taskId, record]): CrewTaskReport => {
              // A finish markCollected persisted just before the timeout must not read
              // back as running: a collected task gets no late-report follow-up either.
              if (record === undefined) return unknownTaskReport(taskId);
              if (record.report !== null) {
                const { result } = record.report;
                return result === null
                  ? record.report
                  : { ...record.report, result: clipLeadReport(result) };
              }
              return {
                taskId,
                role: record.role,
                status: "running",
                result: `Working on ${record.attempts.at(-1)?.model ?? "the task"}.`,
              };
            }),
          ),
      }),
    );
  });

  /**
   * Everything the lead thread changed up to this turn, for the audit prompt: the auditor reads a
   * change it is handed far faster than one it has to find. A diff too big for the prompt, or one
   * that cannot be read, leaves the auditor to read the workspace as before.
   */
  const threadDiffForAudit = (payload: typeof ThreadTurnDiffCompletedPayload.Type) =>
    // Every diff line takes at least two characters, so this turn alone can rule the diff out.
    payload.files.reduce((lines, file) => lines + file.additions + file.deletions, 0) * 2 >
    AUDIT_DIFF_MAX_CHARS
      ? Effect.succeed(null)
      : checkpointDiffs
          .getFullThreadDiff({
            threadId: payload.threadId,
            toTurnCount: payload.checkpointTurnCount,
            ignoreWhitespace: false,
          })
          .pipe(
            Effect.map((result) => auditDiff(result.diff)),
            Effect.orElseSucceed(() => null),
          );

  const maybeAudit = Effect.fn("CrewService.maybeAudit")(function* (
    payload: typeof ThreadTurnDiffCompletedPayload.Type,
  ) {
    const key = `${payload.threadId}:${payload.turnId}`;
    if (auditedTurns.has(key)) return;
    const lead = yield* shellOf(payload.threadId);
    if (Option.isNone(lead)) return;
    const { resolved, options, canLead } = yield* crewFor(lead.value);
    const plan = planTurnAudit({
      changedFiles: payload.files.length,
      changedLines: turnChangedLines(payload.files),
      ...(yield* turnAuditSignals(payload.threadId, payload.turnId)),
      auditorPinned: resolved.pinned.has("auditor"),
      threadTitle: lead.value.title,
      crewEnabled: resolved.enabled && canLead,
      hasAuditor: resolved.roles.auditor !== null,
    });
    if (plan === "none") return;
    auditedTurns.add(key);
    // A turn the user stopped is not reviewed: the auditor's fix turn would restart the lead.
    const latest = lead.value.latestTurn;
    if (
      isStoppedLeadTurn(payload.threadId, payload.turnId) ||
      (latest?.turnId === payload.turnId && latest.state === "interrupted")
    ) {
      return yield* appendActivity({
        threadId: payload.threadId,
        kind: CREW_AUDIT_SKIPPED_ACTIVITY,
        summary: "Audit skipped: the turn was stopped",
        turnId: payload.turnId,
        payload: { crewRole: "auditor", changedFiles: payload.files.length, stopped: true },
      });
    }
    const subject = `Review of ${lead.value.title}`;
    yield* Effect.gen(function* () {
      yield* startTask({
        lead: lead.value,
        role: "auditor",
        resolved,
        options,
        subject,
        prompt: (plan === "light" ? lightAuditPrompt : auditPrompt)({
          leadTitle: lead.value.title,
          files: payload.files.map((file) => file.path),
          request: yield* latestRequestText(payload.threadId),
          diff: yield* threadDiffForAudit(payload),
          turnRefs:
            payload.checkpointTurnCount > 0
              ? {
                  from: checkpointRefForThreadTurn(
                    payload.threadId,
                    payload.checkpointTurnCount - 1,
                  ),
                  to: payload.checkpointRef,
                }
              : null,
        }),
        leadTurnId: payload.turnId,
        // A light audit keeps the auditor's own model when the user pinned it (startTask checks).
        preferFast: plan === "fast" || plan === "light",
      });
    }).pipe(
      // A thread goal waits for this turn's audit, so one that cannot start still has to end.
      Effect.tapError(() =>
        Effect.gen(function* () {
          yield* endBrokenTask({
            lead: lead.value,
            leadTurnId: payload.turnId,
            taskId: yield* uuid,
            role: "auditor",
            subject,
            summary: `Auditor could not start: ${subject}`,
          });
        }),
      ),
    );
  });

  const readRecoveredOutcome = (record: CrewTaskRecord) =>
    Effect.gen(function* () {
      const attempt = record.attempts.at(-1);
      if (attempt?.threadId === undefined || attempt.messageId === undefined) {
        return Option.some<Pick<CrewTaskReport, "status" | "result" | "report">>({
          status: "interrupted",
          result: "The server stopped before the worker start was recorded.",
        });
      }
      const workerTurns = yield* turns.listByThreadId({ threadId: attempt.threadId });
      const turn = workerTurns.find(
        (candidate) => candidate.pendingMessageId === attempt.messageId,
      );
      if (turn === undefined) {
        return Option.some<Pick<CrewTaskReport, "status" | "result" | "report">>({
          status: "interrupted",
          result: "The original worker turn is no longer available.",
        });
      }
      if (turn.state === "pending" || turn.state === "running") {
        return Option.none<Pick<CrewTaskReport, "status" | "result" | "report">>();
      }
      const detail = yield* snapshots.getThreadDetailById(attempt.threadId);
      const reply = Option.isSome(detail)
        ? (detail.value.messages.find(
            (message) => message.id === turn.assistantMessageId && message.turnId === turn.turnId,
          )?.text ?? null)
        : null;
      const status =
        turn.state === "completed"
          ? "completed"
          : turn.state === "error"
            ? "failed"
            : record.stopped === undefined &&
                (yield* lastErrorOf(attempt.threadId)) === ORPHANED_PROVIDER_SESSION_ERROR
              ? // The restart orphaned the member's session: not a user stop, so its
                // half-done worktree is treated like the pre-restart error case.
                "failed"
              : "interrupted";
      const { status: outcome, report } = crewMemberOutcome(record.role, status, reply);
      return Option.some<Pick<CrewTaskReport, "status" | "result" | "report">>({
        status: outcome,
        result: reply === null ? null : clipCrewReport(reply, RESULT_TEXT_LIMIT),
        ...(report === null ? {} : { report }),
      });
    });

  const recoverTask = (record: CrewTaskRecord) =>
    Effect.scoped(
      Effect.gen(function* () {
        let report = record.report;
        // A task that already had its report changes nothing for its lead here; restoreTasks
        // flushes once per lead for those, instead of once per task.
        const reportedBefore = report !== null;
        if (report === null) {
          // Subscribe before reading: a worker can finish while the snapshot is being read.
          const events = yield* engine.subscribeDomainEvents;
          // The stop may have been recorded without reaching the member before the restart.
          if (record.stopped !== undefined) yield* interruptMember(record);
          const current = yield* readRecoveredOutcome(record);
          const observed = Option.isSome(current)
            ? current
            : yield* events.pipe(
                Stream.filter((event) => event.aggregateId === record.attempts.at(-1)?.threadId),
                Stream.mapEffect(() => readRecoveredOutcome(record)),
                Stream.filter(Option.isSome),
                Stream.map((outcome) => outcome.value),
                Stream.runHead,
              );
          const observedOutcome = Option.getOrElse(observed, () => ({
            status: "interrupted" as const,
            result: null,
          }));
          // A task stopped before the restart ends stopped, whatever its cut-off turn reported.
          const outcome =
            record.stopped !== undefined && observedOutcome.status !== "completed"
              ? { status: "interrupted" as const, result: record.stopped }
              : observedOutcome;
          // An isolated member that got as far as a result is merged back; a failed one is dropped.
          if (outcome.status === "failed") yield* dropIsolated(record);
          // A member that finished its turn (whatever status it reported) gets its checks re-run.
          if (
            outcome.status === "completed" ||
            outcome.status === "partial" ||
            outcome.status === "blocked"
          ) {
            yield* sweepTodos(record);
          }
          const finished = withTodoOutcome(
            outcome.status,
            record.todos === undefined ? undefined : todoCounts(record.todos),
          );
          const kept = outcome.status === "failed" ? null : yield* mergeIsolated(record);
          const recoveredStatus =
            leftOut(record, kept) && finished === "completed" ? "partial" : finished;
          // The thread's test runs were not watched across the restart, but its snapshot still
          // shows them, so the proof is judged on it the same way as for a task that ended live.
          const threadId = lastRunThreadId(record);
          const testsPassed =
            threadId === undefined || recoveredStatus === "failed"
              ? false
              : yield* readThreadFacts(threadId).pipe(
                  Effect.map((facts) => facts.testsPassed),
                  Effect.orElseSucceed(() => false),
                );
          const proof = proofOf(
            record,
            recoveredStatus,
            testsPassed,
            "report" in outcome ? outcome.report : undefined,
          );
          report = {
            taskId: record.taskId,
            role: record.role,
            ...outcome,
            status: recoveredStatus,
            result: withNote(
              withNote(
                withNote(outcome.result, todoNoteOf(record)),
                proofLine(proof, recoveredStatus),
              ),
              kept,
            ),
            ...(proof === null ? {} : { proof }),
          };
          yield* updateTask(record, { report });
        }
        yield* Deferred.succeed(record.done, undefined);
        if (record.role === "auditor" && report.status === "completed") {
          yield* queueAuditFix(record, report.result);
        }
        if (!record.ended) {
          const threadId = lastRunThreadId(record);
          const evidence =
            threadId === undefined || report.status === "failed"
              ? {}
              : (yield* completionEvidence(threadId, record.role, report.report)).evidence;
          yield* appendActivity({
            threadId: record.leadThreadId,
            kind: "task.completed",
            summary: `${CREW_ROLE_LABEL[record.role]} recovered: ${record.subject}`,
            turnId: record.leadTurnId,
            payload: {
              taskId: record.taskId,
              title: record.subject,
              agentKind: "agent",
              crewRole: record.role,
              ...(threadId === undefined ? {} : { threadId }),
              ...evidence,
              status: report.status === "interrupted" ? "stopped" : report.status,
              ...(report.proof === undefined ? {} : { proof: report.proof.verdict }),
              ...todoPayload(record),
              ...(report.result === null ? {} : { summary: reportExcerpt(report.result) }),
              ...(record.role === "auditor" ? { verdict: auditVerdict(report.result) } : {}),
            },
          });
          yield* updateTask(record, { ended: true });
        }
        if (
          record.stopped !== undefined &&
          !(report.status === "completed" && record.stopped === STOPPED_ON_REQUEST)
        )
          yield* markCollected(record.taskId, record, { stopped: true });
        if (!reportedBefore) yield* flushFollowUps(record.leadThreadId);
      }),
    );

  // One bad checkpoint is logged and skipped; it must not stop the others from being restored.
  const skipBadCheckpoint = (what: string, id: string) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.logWarning(`crew ${what} checkpoint skipped`, { id, cause }),
    );

  const restoreTasks = Effect.gen(function* () {
    const checkpoints = yield* recovery.readTasks;
    for (const checkpoint of checkpoints) {
      yield* Effect.gen(function* () {
        const state = yield* decodeTaskRecovery(checkpoint.record_json).pipe(
          Effect.mapError(() => new CrewError({ reason: "Invalid crew task checkpoint." })),
        );
        // The audit verdict is not re-derived here: the rules that judge a report change between
        // versions, so the persisted auditState is what the task was left in.
        if (
          state.taskId !== checkpoint.task_id ||
          state.leadThreadId !== checkpoint.lead_thread_id ||
          (state.report !== null &&
            (state.report.taskId !== state.taskId ||
              state.report.role !== state.role ||
              state.report.status === "starting" ||
              state.report.status === "running")) ||
          (state.collected && state.report === null) ||
          (state.auditState === "pending" && (state.role !== "auditor" || state.report === null))
        )
          return yield* fail("Crew task checkpoint identities or states do not match.");
        const record: CrewTaskRecord = {
          ...state,
          attempts: state.attempts.map((attempt) => ({ ...attempt })),
          done: yield* Deferred.make<void>(),
          over: yield* Deferred.make<void>(),
          lock: yield* Semaphore.make(1),
          checkLock: yield* Semaphore.make(1),
        };
        tasks.set(record.taskId, record);
        leadIds.add(record.leadThreadId);
        if (record.role === "auditor" && record.leadTurnId !== null) {
          auditedTurns.add(`${record.leadThreadId}:${record.leadTurnId}`);
        }
      }).pipe(skipBadCheckpoint("task", checkpoint.task_id));
    }
    // An acknowledged delivery may have been interrupted before updating its task checkpoints.
    for (const checkpoint of yield* recovery.readSettledFollowUps) {
      yield* Effect.gen(function* () {
        if (checkpoint.delivered_at === null) {
          yield* recovery.deleteFollowUp(checkpoint.delivery_id);
        } else {
          const data = yield* decodeFollowUp(checkpoint);
          const receipt = yield* receipts.getByCommandId({ commandId: data.command.commandId });
          if (
            Option.isNone(receipt) ||
            receipt.value.status !== "accepted" ||
            receipt.value.aggregateKind !== "thread" ||
            receipt.value.aggregateId !== checkpoint.lead_thread_id
          )
            return yield* fail("Crew delivery acknowledgement has no accepted command receipt.");
          yield* finishFollowUp(checkpoint, data);
        }
      }).pipe(skipBadCheckpoint("follow-up", checkpoint.delivery_id));
    }
    const reportedLeads = new Set<ThreadId>();
    for (const record of tasks.values()) {
      if (record.report !== null) {
        reportedLeads.add(record.leadThreadId);
        yield* recoverTask(record).pipe(Effect.ensuring(Deferred.succeed(record.over, undefined)));
      } else {
        yield* recoverTask(record).pipe(
          Effect.catchCause((cause) => Effect.logWarning("crew recovery paused", { cause })),
          Effect.ensuring(endRun(record)),
          Effect.forkIn(watcherScope),
        );
      }
    }
    for (const leadId of reportedLeads) yield* flushFollowUps(leadId);
  });

  // Subscribe before restoring so nothing that happens during the restore is missed. Neither may
  // stop the service from starting: a failure is logged and crew delegation still works.
  const events = yield* Effect.suspend(() => engine.subscribeDomainEvents).pipe(
    Effect.map(Option.some),
    Effect.catchCause((cause) =>
      Effect.logWarning("crew event watcher could not start", { cause }).pipe(
        Effect.as(Option.none()),
      ),
    ),
  );
  yield* restoreTasks.pipe(
    Effect.catchCause((cause) => Effect.logWarning("crew restore failed", { cause })),
  );
  if (Option.isNone(events))
    return CrewService.of({ roster, delegate, checkTodo, addTodos, retryTask, stop, wait });
  yield* Stream.runForEach(events.value, (event) =>
    // Stopping the lead's turn, or deleting it, stops what it handed to the crew.
    event.type === "thread.turn-interrupt-requested" || event.type === "thread.deleted"
      ? // Noted before the stop is forked, so a diff event right behind it already sees it.
        shellOf(event.payload.threadId).pipe(
          Effect.tap((shell) =>
            Effect.sync(() => {
              const turnId = Option.isSome(shell) ? shell.value.latestTurn?.turnId : undefined;
              if (turnId !== undefined) stoppedLeadTurns.set(event.payload.threadId, turnId);
            }),
          ),
          Effect.andThen(
            stopTasks({
              leadId: event.payload.threadId,
              reason: event.type === "thread.deleted" ? DELETED_LEAD : STOPPED_WITH_LEAD,
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("crew stop with the lead failed", { cause }),
              ),
              // A deleted lead has no later turn to clear its stop marks.
              Effect.ensuring(
                event.type === "thread.deleted"
                  ? Effect.sync(() => forgetLeadStops(event.payload.threadId))
                  : Effect.void,
              ),
              Effect.forkIn(watcherScope),
            ),
          ),
        )
      : event.type === "thread.turn-diff-completed"
        ? maybeAudit(event.payload).pipe(
            Effect.catchCause((cause) => Effect.logWarning("crew audit skipped", { cause })),
            Effect.andThen(flushFollowUps(event.payload.threadId)),
          )
        : event.type === "thread.session-set" &&
            event.payload.session.status !== "running" &&
            event.payload.session.status !== "starting"
          ? flushFollowUps(event.payload.threadId)
          : Effect.void,
  ).pipe(Effect.forkIn(watcherScope));

  return CrewService.of({ roster, delegate, checkTodo, addTodos, retryTask, stop, wait });
});

export const layer = Layer.effect(CrewService, make).pipe(
  Layer.provide(
    Layer.mergeAll(
      CrewRuntimeStateLive.layer,
      OrchestrationCommandReceiptRepositoryLive,
      ProjectionTurnRepositoryLive,
      ProcessRunner.layer,
    ),
  ),
);
