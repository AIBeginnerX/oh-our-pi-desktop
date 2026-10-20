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
  ThreadId,
  type CrewRole,
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
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  CREW_MAX_FIX_ROUNDS,
  CREW_MAX_FOLLOW_UPS,
  CREW_ROLE_LABEL,
  AUDIT_DIFF_MAX_CHARS,
  auditDiff,
  auditPrompt,
  auditVerdict,
  followUpRound,
  isCrewFollowUp,
  planFollowUp,
  crewTaskStatus,
  crewExhaustedReport,
  crewThreadTitle,
  delegatePrompt,
  isCrewThreadTitle,
  isSettledCrewStatus,
  reportExcerpt,
  latestAuditAsksChanges,
  planTurnAudit,
  turnChangedLines,
  turnRanPassingTests,
  type CrewTaskOutcome,
  crewFailureKind,
  crewReportStatus,
} from "./crewLogic.ts";

const MAX_WAIT_SECONDS = 50;
const RESULT_TEXT_LIMIT = 6_000;
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
  threadId?: ThreadId;
  error?: string;
}

interface CrewTaskRecord {
  readonly leadThreadId: ThreadId;
  readonly leadTurnId: TurnId | null;
  readonly role: CrewRole;
  readonly subject: string;
  readonly attempts: CrewAttempt[];
  report: CrewTaskReport | null;
  /** The lead has this report: crew_wait returned it, or a follow-up turn carried it. */
  collected: boolean;
  /** The lead's board has this task's task.completed, so nothing waits on it any more. */
  ended: boolean;
  readonly done: Deferred.Deferred<void>;
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const checkpointDiffs = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const crypto = yield* Crypto.Crypto;

  // Watchers outlive the tool call that started them, so they run in the service's own scope.
  const watcherScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(watcherScope, Exit.void));

  const tasks = new Map<string, CrewTaskRecord>();
  const auditedTurns = new Set<string>();
  // Audit reports that asked for changes, waiting for the lead to be idle.
  const pendingAudits = new Map<ThreadId, string[]>();
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
        return reply === undefined ? null : reply.text.slice(0, RESULT_TEXT_LIMIT);
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
    readonly lead: OrchestrationThreadShell;
    readonly role: CrewRole;
    readonly option: CrewModelOption;
    readonly subject: string;
    readonly prompt: string;
  }) {
    const threadId = ThreadId.make(yield* uuid);
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
      branch: input.lead.branch,
      worktreePath: input.lead.worktreePath,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:crew-turn:${threadId}`),
      threadId,
      message: {
        messageId: MessageId.make(yield* uuid),
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

  /** The last message the user wrote in a lead thread, skipping OoP's crew follow-ups. */
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
      if (record.collected || record.role === "auditor") return;
      record.collected = true;
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
      if (auditVerdict(report) !== "needs-changes" || report === null) return;
      const current = followUpRound(yield* latestUserText(record.leadThreadId));
      if (current.fixes >= CREW_MAX_FIX_ROUNDS || current.round >= CREW_MAX_FOLLOW_UPS) return;
      pendingAudits.set(record.leadThreadId, [
        ...(pendingAudits.get(record.leadThreadId) ?? []),
        report,
      ]);
      yield* appendActivity({
        threadId: record.leadThreadId,
        kind: "crew.follow-up",
        summary: "The auditor asked for changes; the lead gets a follow-up turn",
        turnId: record.leadTurnId,
        payload: { reason: "audit" },
      });
    });

  /**
   * Hands the lead what the crew finished after it answered (audit fixes, uncollected reports)
   * as one follow-up turn, once the lead is idle and no audit of its last turn is running.
   */
  const flushFollowUps = (leadId: ThreadId) =>
    followUpLock
      .withPermits(1)(
        Effect.gen(function* () {
          const lead = yield* shellOf(leadId);
          if (Option.isNone(lead) || isCrewThreadTitle(lead.value.title) || !leadIdle(lead.value))
            return;
          const records = [...tasks.entries()].filter(
            ([, record]) => record.leadThreadId === leadId,
          );
          if (records.some(([, record]) => record.role === "auditor" && record.report === null))
            return;
          const audits = pendingAudits.get(leadId) ?? [];
          const late = records.filter(
            ([, record]) =>
              record.role !== "auditor" && record.report !== null && !record.collected,
          );
          if (audits.length === 0 && late.length === 0) return;
          pendingAudits.delete(leadId);
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
          for (const [taskId, record] of late) {
            yield* markCollected(taskId, record, plan.prompt === null ? { dropped: true } : {});
          }
          if (plan.prompt === null) return;
          const createdAt = yield* nowIso;
          yield* appendActivity({
            threadId: leadId,
            kind: "crew.follow-up",
            summary: "OOP Crew sent the lead a follow-up turn",
            turnId: lead.value.latestTurn?.turnId ?? null,
            payload: { reason: audits.length > 0 ? "audit" : "results", results: late.length },
          });
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`server:crew-follow-up:${leadId}:${yield* uuid}`),
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
          });
        }),
      )
      .pipe(Effect.catchCause((cause) => Effect.logWarning("crew follow-up skipped", { cause })));

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
          record.report = { taskId: input.taskId, role: record.role, ...report };
          yield* Deferred.succeed(record.done, undefined);
        });

      for (const option of input.chain) {
        if (record.attempts.length > 0 && (yield* cooling).has(option.selection.instanceId))
          continue;
        const previous = record.attempts.at(-1);
        const attempt: CrewAttempt = { model: `${option.label} (${option.providerLabel})` };
        record.attempts.push(attempt);
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
            lead: input.lead,
            role: record.role,
            option,
            subject: input.subject,
            prompt: input.prompt,
          }),
        );
        if (Exit.isFailure(launched)) {
          attempt.error = "could not start";
          yield* markFailed(option.selection.instanceId, attempt.error);
          continue;
        }
        const threadId = launched.value;
        attempt.threadId = threadId;
        const status = yield* settled(threadId);
        const reply = yield* lastAssistantText(threadId);
        if (status === "completed" || status === "interrupted") {
          const reportStatus =
            status === "completed" && record.role !== "auditor" ? crewReportStatus(reply) : "done";
          const outcome: CrewTaskOutcome = reportStatus === "done" ? status : reportStatus;
          yield* finish({ status: outcome, result: reply });
          if (record.role === "auditor" && status === "completed")
            yield* queueAuditFix(record, reply);
          yield* appendActivity({
            threadId: input.lead.id,
            kind: "task.completed",
            summary: `${label} ${outcome === "completed" ? "finished" : outcome === "partial" ? "finished part of" : outcome === "blocked" ? "is blocked on" : "stopped"}: ${input.subject}`,
            turnId: input.leadTurnId,
            payload: {
              ...base,
              model: option.label,
              status: outcome === "interrupted" ? "stopped" : outcome,
              ...(reply === null ? {} : { summary: reportExcerpt(reply) }),
              // Thread goals read the verdict to wait for an approving audit.
              ...(record.role === "auditor" ? { verdict: auditVerdict(reply) } : {}),
            },
          });
          record.ended = true;
          yield* settleThread(threadId);
          yield* flushFollowUps(record.leadThreadId);
          return;
        }
        attempt.error = (yield* lastErrorOf(threadId)) ?? "the turn failed";
        yield* markFailed(option.selection.instanceId, attempt.error);
        yield* settleThread(threadId);
      }

      const report = crewExhaustedReport(record.role, record.attempts);
      yield* finish({ status: "failed", result: report });
      yield* appendActivity({
        threadId: input.lead.id,
        kind: "task.completed",
        summary: `${label} failed on every crew model; the lead takes it: ${input.subject}`,
        turnId: input.leadTurnId,
        payload: { ...base, status: "failed", summary: reportExcerpt(report) },
      });
      record.ended = true;
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
    const record: CrewTaskRecord = {
      leadThreadId: input.lead.id,
      leadTurnId: input.leadTurnId,
      role: input.role,
      subject: input.subject,
      attempts: [],
      report: null,
      collected: false,
      ended: false,
      done: yield* Deferred.make<void>(),
    };
    tasks.set(taskId, record);
    yield* runTask({ ...input, taskId, record, chain }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("crew task stopped", { cause });
          if (record.ended) return;
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
    return { taskId, model: `${first.label} (${first.providerLabel})` };
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
      return yield* startTask({
        lead,
        role: input.role,
        resolved,
        options,
        subject: input.title?.trim() || task,
        prompt: delegatePrompt({ role: input.role, leadTitle: lead.title, task }),
        leadTurnId: lead.latestTurn?.turnId ?? null,
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

  yield* Effect.scoped(
    Effect.gen(function* () {
      const events = yield* engine.subscribeDomainEvents;
      yield* Stream.runForEach(events, (event) =>
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
      );
    }),
  ).pipe(Effect.forkIn(watcherScope));

  return CrewService.of({ roster, delegate, wait });
});

export const layer = Layer.effect(CrewService, make);
