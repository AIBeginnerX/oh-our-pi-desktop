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
  ThreadId,
  type CrewRole,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  ThreadTurnDiffCompletedPayload,
  type TurnId,
} from "@t3tools/contracts";
import {
  crewFallbackChain,
  crewModelOptions,
  resolveCrew,
  type CrewModelOption,
  type ResolvedCrew,
} from "@t3tools/shared/crew";
import { CREW_AUDIT_SKIPPED_ACTIVITY } from "@t3tools/shared/threadGoal";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
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
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CrewRuntimeStateLive from "../persistence/Layers/CrewRuntimeState.ts";
import { CrewRuntimeState } from "../persistence/Services/CrewRuntimeState.ts";
import type { CrewFollowUpCheckpoint } from "../persistence/Services/CrewRuntimeState.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import { ProjectionTurnRepository } from "../persistence/Services/ProjectionTurns.ts";
import { CrewFollowUpRecoveryJson, CrewTaskRecoveryJson } from "./crewRecoveryState.ts";
import { makeCrewWorktrees, mergeConflictNote, type CrewWorktree } from "./crewWorktree.ts";
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
  crewMemberOutcome,
  followUpRound,
  isCrewFollowUp,
  planFollowUp,
  crewTaskStatus,
  crewExhaustedReport,
  crewThreadTitle,
  delegatePrompt,
  isCrewThreadTitle,
  isSettledCrewStatus,
  overlappingWriteScopes,
  reportExcerpt,
  latestAuditAsksChanges,
  planTurnAudit,
  turnChangedLines,
  turnRanPassingTests,
  writeScopeWarning,
  type CrewMemberReport,
  type CrewTaskOutcome,
  crewFailureKind,
  ISOLATED_CHECKOUT_PROMPT,
} from "./crewLogic.ts";

const MAX_WAIT_SECONDS = 50;
const RESULT_TEXT_LIMIT = 6_000;
const ISOLATION_FALLBACK_WARNING =
  "The task started in the shared workspace: an isolated worktree could not be created (the workspace is not a git repository with a commit, or git failed).";
// A provider that just failed (sign-in, balance, outage) is skipped by new chains for a while,
// so parallel tasks do not each spend a minute rediscovering the same failure.
const FAILED_PROVIDER_COOLDOWN_MS = 10 * 60_000;

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
}

export interface CrewTaskReport {
  readonly taskId: string;
  readonly role: CrewRole | null;
  readonly status: CrewTaskOutcome;
  readonly result: string | null;
  /** The crew member's JSON report, when its reply ended with one that decodes. */
  readonly report?: CrewMemberReport | undefined;
}

export class CrewService extends Context.Service<
  CrewService,
  {
    readonly roster: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly enabled: boolean; readonly roles: CrewRosterEntry[] }, CrewError>;
    readonly delegate: (input: {
      readonly threadId: ThreadId;
      readonly role: "worker" | "expert";
      readonly task: string;
      readonly title?: string | undefined;
      readonly writeScope?: ReadonlyArray<string> | undefined;
      readonly verify?: string | undefined;
      readonly doneWhen?: string | undefined;
      /** "worktree" runs the task in its own git worktree and applies its changes back. */
      readonly isolation?: "shared" | "worktree" | undefined;
    }) => Effect.Effect<
      { readonly taskId: string; readonly model: string; readonly warning?: string | undefined },
      CrewError
    >;
    /** Runs a worker or expert task that ended without finishing again, as a new task. */
    readonly retryTask: (input: {
      readonly threadId: ThreadId;
      readonly taskId: string;
    }) => Effect.Effect<{ readonly taskId: string; readonly model: string }, CrewError>;
    readonly wait: (input: {
      readonly threadId: ThreadId;
      readonly taskIds: ReadonlyArray<string>;
      readonly timeoutSeconds?: number | undefined;
    }) => Effect.Effect<ReadonlyArray<CrewTaskReport>, CrewError>;
  }
>()("t3/crew/CrewService") {}

interface CrewAttempt {
  readonly model: string;
  threadId?: ThreadId | undefined;
  messageId?: MessageId | undefined;
  error?: string | undefined;
}

interface CrewTaskRecord {
  readonly taskId: string;
  readonly leadThreadId: ThreadId;
  readonly leadTurnId: TurnId | null;
  readonly role: CrewRole;
  readonly subject: string;
  /** The repo-relative paths the task may change, when the lead named them. */
  readonly writeScope?: ReadonlyArray<string> | undefined;
  /** The task's own worktree, when it runs isolated from the lead's workspace. */
  readonly worktree?: CrewWorktree | undefined;
  readonly attempts: CrewAttempt[];
  report: CrewTaskReport | null;
  /** The lead has this report: crew_wait returned it, or a follow-up turn carried it. */
  collected: boolean;
  /** The lead's board has this task's task.completed, so nothing waits on it any more. */
  ended: boolean;
  auditState: "none" | "pending" | "delivered" | "skipped";
  readonly done: Deferred.Deferred<void>;
  readonly lock: Semaphore.Semaphore;
}

/** The thread of the last attempt that got as far as launching a crew thread. */
const lastRunThreadId = (record: Pick<CrewTaskRecord, "attempts">) =>
  record.attempts.findLast((attempt) => attempt.error !== "could not start")?.threadId;

const encodeTaskRecovery = Schema.encodeEffect(CrewTaskRecoveryJson);
const decodeTaskRecovery = Schema.decodeEffect(CrewTaskRecoveryJson);
const encodeFollowUpRecovery = Schema.encodeEffect(CrewFollowUpRecoveryJson);
const decodeFollowUpRecovery = Schema.decodeEffect(CrewFollowUpRecoveryJson);

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const checkpointDiffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const crypto = yield* Crypto.Crypto;
  const recovery = yield* CrewRuntimeState;
  const receipts = yield* OrchestrationCommandReceiptRepository;
  const turns = yield* ProjectionTurnRepository;
  const worktrees = yield* makeCrewWorktrees;

  // Watchers outlive the tool call that started them, so they run in the service's own scope.
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const tasks = new Map<string, CrewTaskRecord>();
  const auditedTurns = new Set<string>();
  const followUpLock = yield* Semaphore.make(1);
  const failedProviders = new Map<string, number>();
  // A billing or sign-in failure lasts until the provider's status is checked again (the
  // provider's checkedAt then passes the one recorded here); a cooldown would only retry it.
  const blockedProviders = new Map<string, string>();
  const cooling = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    if (blockedProviders.size > 0) {
      const snapshot = yield* providers.getProviders;
      for (const [instanceId, checkedAt] of blockedProviders) {
        const provider = snapshot.find((entry) => entry.instanceId === instanceId);
        if (provider === undefined || provider.checkedAt > checkedAt) {
          blockedProviders.delete(instanceId);
        }
      }
    }
    return new Set([
      ...[...failedProviders].flatMap(([instanceId, until]) => (until > now ? [instanceId] : [])),
      ...blockedProviders.keys(),
    ]);
  });
  const markFailed = (instanceId: string, error: string | undefined) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      failedProviders.set(instanceId, now + FAILED_PROVIDER_COOLDOWN_MS);
      if (crewFailureKind(error) === "other") return;
      const provider = (yield* providers.getProviders).find(
        (entry) => entry.instanceId === instanceId,
      );
      blockedProviders.set(instanceId, provider?.checkedAt ?? "");
    });

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const fail = (reason: string) => Effect.fail(new CrewError({ reason }));

  const persistTask = (record: Omit<CrewTaskRecord, "done" | "lock">) =>
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
        attempts: record.attempts,
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
    patch: Partial<Pick<CrewTaskRecord, "report" | "collected" | "ended" | "auditState">>,
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
      threadId: lead.id,
      providers: snapshot,
      brain: lead.modelSelection,
    });
    return { resolved, options: crewModelOptions(snapshot) };
  });

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind: string;
    readonly summary: string;
    readonly turnId: TurnId | null;
    readonly payload: Record<string, unknown>;
  }) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const activity: OrchestrationThreadActivity = {
        id: EventId.make(yield* uuid),
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

  /** Resolves when the crew thread settles; a domain event for it is the cue to re-read. */
  const settled = (threadId: ThreadId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const now = yield* statusOf(threadId);
        if (isSettledCrewStatus(now)) return now;
        const next = yield* events.pipe(
          Stream.filter((event) => event.aggregateId === threadId),
          Stream.mapEffect(() => statusOf(threadId)),
          Stream.filter(isSettledCrewStatus),
          Stream.runHead,
        );
        return Option.getOrElse(next, () => "interrupted" as const);
      }),
    );

  const lastAssistantText = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map((thread) => {
        if (Option.isNone(thread)) return null;
        const reply = thread.value.messages.findLast((message) => message.role === "assistant");
        return reply === undefined ? null : reply.text;
      }),
      Effect.orElseSucceed(() => null),
    );

  const lastErrorOf = (threadId: ThreadId) =>
    shellOf(threadId).pipe(
      Effect.map((shell) =>
        Option.isNone(shell) ? null : (shell.value.session?.lastError ?? null),
      ),
    );

  const settleThread = (threadId: ThreadId) =>
    Effect.gen(function* () {
      yield* engine.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`server:crew-settle:${threadId}:${yield* uuid}`),
        threadId,
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
  }) {
    const threadId = input.threadId;
    const createdAt = yield* nowIso;
    const interactionMode = input.role === "auditor" ? "plan" : "default";
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
        text: input.prompt,
        attachments: [],
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
  const crewThreadFacts = (threadId: ThreadId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const events = yield* engine.subscribeDomainEvents;
        const read = snapshots
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

  /** The `tested` and `usage` fields of a finished task's board activity. */
  const completionEvidence = (
    threadId: ThreadId,
    role: CrewRole,
    report: CrewMemberReport | undefined,
  ) =>
    crewThreadFacts(threadId).pipe(
      Effect.map(({ usage, testsPassed }) => ({
        // Observed (a passing test run in the thread) or self-reported by the member's JSON report.
        ...(role === "auditor"
          ? {}
          : { tested: testsPassed || report?.verification?.passed === true }),
        ...(usage === null ? {} : { usage }),
      })),
    );

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
      },
    }).pipe(Effect.ignore);

  /**
   * An audit that asked for changes becomes a follow-up lead turn while the fix limit allows.
   * The follow-up is announced before the audit's completion so nothing watching the lead sees
   * a quiet thread in between.
   */
  const queueAuditFix = (record: CrewTaskRecord, report: string | null) =>
    Effect.gen(function* () {
      if (record.auditState !== "none") return;
      const current = followUpRound(yield* latestUserText(record.leadThreadId));
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
    });

  /**
   * Hands the lead what the crew finished after it answered (audit fixes, uncollected reports)
   * as one follow-up turn, once the lead is idle and no audit of its last turn is running.
   */
  const flushFollowUps = (leadId: ThreadId) =>
    followUpLock
      .withPermits(1)(
        Effect.gen(function* () {
          const checkpoints = yield* recovery.readFollowUps;
          const pending = checkpoints.find(
            (checkpoint) =>
              checkpoint.lead_thread_id === leadId &&
              checkpoint.delivered_at === null &&
              checkpoint.rejected_at === null,
          );
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
            } else {
              const lead = yield* shellOf(leadId);
              if (Option.isNone(lead) || !leadIdle(lead.value)) return;
              yield* engine.dispatch(data.command);
              yield* finishFollowUp(pending, data);
              return;
            }
          }
          const lead = yield* shellOf(leadId);
          if (Option.isNone(lead) || isCrewThreadTitle(lead.value.title) || !leadIdle(lead.value))
            return;
          const records = [...tasks.entries()].filter(
            ([, record]) => record.leadThreadId === leadId,
          );
          if (records.some(([, record]) => record.role === "auditor" && record.report === null))
            return;
          const auditRecords = records.filter(([, record]) => record.auditState === "pending");
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
          const plan = planFollowUp({
            current: followUpRound(yield* latestUserText(leadId)),
            audits,
            results: late.map(([, record]) => ({
              role: record.role,
              subject: record.subject,
              status: record.report?.status ?? "completed",
              report: record.report?.result ?? null,
            })),
          });
          if (plan.prompt === null) {
            for (const [taskId, record] of late) {
              yield* markCollected(taskId, record, { dropped: true });
            }
            for (const [, record] of auditRecords) {
              yield* updateTask(record, { auditState: "skipped" });
            }
            return;
          }
          const createdAt = yield* nowIso;
          const deliveryId = yield* uuid;
          const data: typeof CrewFollowUpRecoveryJson.Type = {
            version: 1,
            taskIds: late.map(([taskId]) => taskId),
            auditTaskIds: auditRecords.map(([taskId]) => taskId),
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

  /** A worktree for an isolated task, or none when the lead's workspace cannot give it one. */
  const isolate = (lead: OrchestrationThreadShell, taskId: string) =>
    Effect.gen(function* () {
      const project =
        lead.worktreePath === null
          ? yield* snapshots.getProjectShellById(lead.projectId)
          : Option.none();
      const cwd =
        lead.worktreePath ?? Option.getOrNull(Option.map(project, (shell) => shell.workspaceRoot));
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
      const result = yield* worktrees.mergeBack(record.worktree);
      return result.merged ? null : mergeConflictNote(record.worktree, result);
    });

  /** A task that produced no usable result leaves the lead's workspace alone. */
  const dropIsolated = (record: CrewTaskRecord) =>
    record.worktree === undefined ? Effect.void : worktrees.discard(record.worktree);

  /** A report's text with the merge note after it, which the clip must not cut. */
  const withNote = (text: string | null, note: string | null) =>
    note === null ? text : `${text ?? ""}${note}`;

  /**
   * Runs one crew task down its fallback chain. A model that fails hands the same task to the
   * next model in the chain; the lead's board shows each switch, and the brain only takes the
   * task back once every model has failed. A task the user interrupts is not retried.
   */
  const runTask = (input: {
    readonly lead: OrchestrationThreadShell;
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

      for (const option of input.chain) {
        if (record.attempts.length > 0 && (yield* cooling).has(option.selection.instanceId))
          continue;
        const previous = record.attempts.at(-1);
        const attempt: CrewAttempt = { model: `${option.label} (${option.providerLabel})` };
        attempt.threadId = ThreadId.make(yield* uuid);
        attempt.messageId = MessageId.make(yield* uuid);
        record.attempts.push(attempt);
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
            ...(previous === undefined
              ? {}
              : {
                  summary: reportExcerpt(
                    `${previous.model} failed (${previous.error ?? "failed"}); retrying with ${option.label}.`,
                  ),
                }),
          },
        });
        const launched = yield* Effect.exit(
          launchCrewThread({
            threadId: attempt.threadId,
            messageId: attempt.messageId,
            lead: input.lead,
            role: record.role,
            option,
            subject: input.subject,
            prompt: input.prompt,
            worktree: record.worktree,
          }),
        );
        if (Exit.isFailure(launched)) {
          attempt.error = "could not start";
          yield* persistTask(record);
          yield* markFailed(option.selection.instanceId, attempt.error);
          continue;
        }
        const threadId = launched.value;
        attempt.threadId = threadId;
        const status = yield* settled(threadId);
        // Status and verdict are judged on the full report; only the stored result is clipped.
        const reply = yield* lastAssistantText(threadId);
        if (status === "completed" || status === "interrupted") {
          const { status: memberStatus, report } = crewMemberOutcome(record.role, status, reply);
          const kept = yield* mergeIsolated(record);
          // Changes that did not reach the workspace leave the task unfinished.
          const outcome: CrewTaskOutcome =
            kept !== null && memberStatus === "completed" ? "partial" : memberStatus;
          yield* finish({
            status: outcome,
            result: withNote(
              reply === null ? null : clipCrewReport(reply, RESULT_TEXT_LIMIT),
              kept,
            ),
            ...(report === null ? {} : { report }),
          });
          const evidence = yield* completionEvidence(threadId, record.role, report ?? undefined);
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
              ...(reply === null ? {} : { summary: reportExcerpt(reply) }),
              // Thread goals read the verdict to wait for an approving audit.
              ...(record.role === "auditor" ? { verdict: auditVerdict(reply) } : {}),
            },
          });
          yield* updateTask(record, { ended: true });
          yield* settleThread(threadId);
          yield* flushFollowUps(record.leadThreadId);
          return;
        }
        attempt.error = (yield* lastErrorOf(threadId)) ?? "the turn failed";
        yield* persistTask(record);
        yield* markFailed(option.selection.instanceId, attempt.error);
        yield* settleThread(threadId);
      }

      const report = crewExhaustedReport(record.role, record.attempts);
      yield* dropIsolated(record);
      yield* finish({ status: "failed", result: report });
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
    readonly writeScope?: ReadonlyArray<string> | undefined;
    readonly isolation?: "shared" | "worktree" | undefined;
    /** Run the task on the cheapest model available instead of the role's own. */
    readonly preferFast?: boolean;
  }) {
    const brain = input.lead.modelSelection;
    const fastest =
      input.preferFast === true
        ? (input.options.find(
            (option) =>
              option.tier === 1 &&
              (brain === null ||
                option.selection.instanceId !== brain.instanceId ||
                option.selection.model !== brain.model),
          ) ?? null)
        : null;
    const chain = crewFallbackChain({
      options: input.options,
      role: input.role,
      assigned: fastest ?? input.resolved.roles[input.role],
      preset: input.resolved.preset,
      brain: input.lead.modelSelection,
      unavailableInstances: yield* cooling,
    });
    const first = chain[0];
    if (first === undefined) {
      return yield* fail(
        `No model is available for the ${CREW_ROLE_LABEL[input.role].toLowerCase()} role. Do the work yourself.`,
      );
    }
    const taskId = yield* uuid;
    const worktree =
      input.isolation === "worktree" ? yield* isolate(input.lead, taskId) : undefined;
    const record: CrewTaskRecord = {
      taskId,
      leadThreadId: input.lead.id,
      leadTurnId: input.leadTurnId,
      role: input.role,
      subject: input.subject,
      writeScope: input.writeScope,
      worktree,
      attempts: [],
      report: null,
      collected: false,
      ended: false,
      auditState: "none",
      done: yield* Deferred.make<void>(),
      lock: yield* Semaphore.make(1),
    };
    yield* persistTask(record);
    tasks.set(taskId, record);
    yield* runTask({
      ...input,
      prompt:
        worktree === undefined ? input.prompt : `${input.prompt}\n\n${ISOLATED_CHECKOUT_PROMPT}`,
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
          });
        }),
      ),
      Effect.forkIn(watcherScope),
    );
    return {
      taskId,
      model: `${first.label} (${first.providerLabel})`,
      isolated: worktree !== undefined,
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
      const { resolved } = yield* crewFor(lead);
      return {
        enabled: resolved.enabled,
        roles: (["worker", "expert", "auditor"] as const).map((role) => ({
          role,
          model: resolved.roles[role]?.label ?? null,
          provider: resolved.roles[role]?.providerLabel ?? null,
        })),
      };
    },
  );

  const delegate: CrewService["Service"]["delegate"] = Effect.fn("CrewService.delegate")(
    function* (input) {
      const lead = yield* requireLead(input.threadId);
      const { resolved, options } = yield* crewFor(lead);
      if (!resolved.enabled) {
        return yield* fail("OOP Crew is off for this thread. Do the work yourself.");
      }
      const task = input.task.trim();
      if (task.length === 0) return yield* fail("Describe the task to hand over.");
      const writeScope = input.writeScope?.map((path) => path.trim()).filter((path) => path !== "");
      const { isolated, ...started } = yield* startTask({
        lead,
        role: input.role,
        resolved,
        options,
        subject: input.title?.trim() || task,
        prompt: delegatePrompt({
          role: input.role,
          leadTitle: lead.title,
          task,
          writeScope,
          verify: input.verify,
          doneWhen: input.doneWhen,
        }),
        leadTurnId: lead.latestTurn?.turnId ?? null,
        writeScope,
        isolation: input.isolation,
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
        input.isolation === "worktree" && !isolated ? ISOLATION_FALLBACK_WARNING : null,
        overlap,
      ]
        .filter((line) => line !== null)
        .join("\n");
      return warning === "" ? started : { ...started, warning };
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
        if (text !== undefined) return text;
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
      const { resolved, options } = yield* crewFor(lead);
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
      const prompt = yield* originalPrompt(record);
      if (prompt === null) return yield* fail("The task's original brief is no longer available.");
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
        isolation: record.worktree === undefined ? undefined : "worktree",
      });
    },
  );

  const wait: CrewService["Service"]["wait"] = Effect.fn("CrewService.wait")(function* (input) {
    const seconds = Math.min(Math.max(input.timeoutSeconds ?? 40, 1), MAX_WAIT_SECONDS);
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
          return {
            taskId,
            role: null,
            status: "failed",
            result: "Unknown task id; it may be from before the server restarted.",
          } satisfies CrewTaskReport;
        }
        if (record.report !== null) {
          yield* markCollected(taskId, record);
          return record.report;
        }
        const current = record.attempts.at(-1);
        return {
          taskId,
          role: record.role,
          status: current?.threadId === undefined ? "starting" : yield* statusOf(current.threadId),
          result: current === undefined ? null : `Working on ${current.model}.`,
        } satisfies CrewTaskReport;
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
    const { resolved, options } = yield* crewFor(lead.value);
    const plan = planTurnAudit({
      changedFiles: payload.files.length,
      changedLines: turnChangedLines(payload.files),
      ...(yield* turnAuditSignals(payload.threadId, payload.turnId)),
      auditorPinned: resolved.pinned.has("auditor"),
      threadTitle: lead.value.title,
      crewEnabled: resolved.enabled,
      hasAuditor: resolved.roles.auditor !== null,
    });
    if (plan === "none") return;
    auditedTurns.add(key);
    if (plan === "skipped") {
      // A thread goal waits for this turn's audit, so a skipped one is recorded, not silent.
      return yield* appendActivity({
        threadId: payload.threadId,
        kind: CREW_AUDIT_SKIPPED_ACTIVITY,
        summary: "Audit skipped: a small change whose tests passed",
        turnId: payload.turnId,
        payload: { crewRole: "auditor", changedFiles: payload.files.length },
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
        prompt: auditPrompt({
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
        preferFast: plan === "fast",
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
        if (report === null) {
          // Subscribe before reading: a worker can finish while the snapshot is being read.
          const events = yield* engine.subscribeDomainEvents;
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
          const outcome = Option.getOrElse(observed, () => ({
            status: "interrupted" as const,
            result: null,
          }));
          // An isolated member that got as far as a result is merged back; a failed one is dropped.
          if (outcome.status === "failed") yield* dropIsolated(record);
          const kept = outcome.status === "failed" ? null : yield* mergeIsolated(record);
          report = {
            taskId: record.taskId,
            role: record.role,
            ...outcome,
            status: kept !== null && outcome.status === "completed" ? "partial" : outcome.status,
            result: withNote(outcome.result, kept),
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
              : yield* completionEvidence(threadId, record.role, report.report);
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
              ...(report.result === null ? {} : { summary: reportExcerpt(report.result) }),
              ...(record.role === "auditor" ? { verdict: auditVerdict(report.result) } : {}),
            },
          });
          yield* updateTask(record, { ended: true });
        }
        yield* flushFollowUps(record.leadThreadId);
      }),
    );

  const restoreTasks = Effect.gen(function* () {
    const checkpoints = yield* recovery.readTasks;
    for (const checkpoint of checkpoints) {
      const state = yield* decodeTaskRecovery(checkpoint.record_json).pipe(
        Effect.mapError(() => new CrewError({ reason: "Invalid crew task checkpoint." })),
      );
      if (
        state.taskId !== checkpoint.task_id ||
        state.leadThreadId !== checkpoint.lead_thread_id ||
        (state.report !== null &&
          (state.report.taskId !== state.taskId ||
            state.report.role !== state.role ||
            state.report.status === "starting" ||
            state.report.status === "running")) ||
        (state.collected && state.report === null) ||
        (state.auditState === "pending" &&
          (state.role !== "auditor" ||
            state.report === null ||
            auditVerdict(state.report.result) !== "needs-changes"))
      )
        return yield* fail("Crew task checkpoint identities or states do not match.");
      const record: CrewTaskRecord = {
        ...state,
        attempts: state.attempts.map((attempt) => ({ ...attempt })),
        done: yield* Deferred.make<void>(),
        lock: yield* Semaphore.make(1),
      };
      tasks.set(record.taskId, record);
      if (record.role === "auditor" && record.leadTurnId !== null) {
        auditedTurns.add(`${record.leadThreadId}:${record.leadTurnId}`);
      }
    }
    // An acknowledged delivery may have been interrupted before updating its task checkpoints.
    for (const checkpoint of yield* recovery.readFollowUps) {
      const data = yield* decodeFollowUp(checkpoint);
      if (checkpoint.delivered_at !== null) {
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
    }
    for (const record of tasks.values()) {
      if (record.report !== null) {
        yield* recoverTask(record);
      } else {
        yield* recoverTask(record).pipe(
          Effect.catchCause((cause) => Effect.logWarning("crew recovery paused", { cause })),
          Effect.forkIn(watcherScope),
        );
      }
    }
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
  if (Option.isNone(events)) return CrewService.of({ roster, delegate, retryTask, wait });
  yield* Stream.runForEach(events.value, (event) =>
    event.type === "thread.turn-diff-completed"
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

  return CrewService.of({ roster, delegate, retryTask, wait });
});

export const layer = Layer.effect(CrewService, make).pipe(
  Layer.provide(
    Layer.mergeAll(
      CrewRuntimeStateLive.layer,
      OrchestrationCommandReceiptRepositoryLive,
      ProjectionTurnRepositoryLive,
    ),
  ),
);
