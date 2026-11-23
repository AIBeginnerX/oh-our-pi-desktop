import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type ServerSettings,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  PULL_REQUEST_AUTO_FIX_ACTIVITY as activity,
  pullRequestAutoFixDecision,
  pullRequestAutoFixProgress,
  pullRequestAutoFixPrompt,
  pullRequestAutoFixTarget,
} from "@t3tools/shared/pullRequestAutoFix";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { PullRequestService } from "../pullRequest/PullRequestService.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { hasQueuedTurnStartForThread, openRequests } from "./decider.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

export class PullRequestAutoFixReactor extends Context.Service<
  PullRequestAutoFixReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/PullRequestAutoFixReactor") {}

// Only this feature's records, so a busy thread's other activities cannot push an old attempt
// out of the bounded read. Open approvals and questions arrive with the pinned activities.
const activityKinds = Object.values(activity);

const isBusy = (status: string | undefined) => status === "running" || status === "starting";

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const pullRequests = yield* PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const retryChecks = new Set<ThreadId>();
  const checkFailures = new Map<ThreadId, { delay: number; retryAt: number }>();

  const readCandidate = Effect.fnUntraced(function* (threadId: ThreadId) {
    const map = (yield* settingsService.getSettings).threadPullRequestAutoFix;
    const setting = map[threadId];
    if (!setting?.enabled) return null;

    const thread = Option.getOrNull(
      yield* snapshots.getThreadDetailById(threadId, {
        activityKinds,
        includePinnedActivities: true,
      }),
    );
    const now = yield* nowIso;
    if (
      thread === null ||
      thread.archivedAt !== null ||
      thread.deletedAt !== null ||
      thread.settledOverride === "settled" ||
      (thread.snoozedUntil != null && Date.parse(thread.snoozedUntil) > Date.parse(now))
    )
      return null;
    if (
      isBusy(thread.session?.status) ||
      thread.latestTurn?.state === "running" ||
      // Stop means stop: nothing starts on its own until the thread finishes another turn.
      thread.latestTurn?.state === "interrupted" ||
      openRequests(thread).size > 0 ||
      hasQueuedTurnStartForThread(thread, now)
    )
      return null;

    const link = pullRequestAutoFixTarget(thread.pullRequests, thread.branch);
    const headBranch = link?.snapshot?.headBranch;
    if (link === null || headBranch === undefined) return null;
    const progress = pullRequestAutoFixProgress(link.url, setting.setAt, thread.activities);
    return { thread, map, setting, link, headBranch, progress };
  });

  const review = Effect.fn("PullRequestAutoFixReactor.review")(function* (threadId: ThreadId) {
    retryChecks.delete(threadId);
    const candidate = yield* readCandidate(threadId);
    if (candidate === null) return;
    const { thread, map, setting, link, progress } = candidate;
    const decision = pullRequestAutoFixDecision(link.snapshot?.checksState, progress);
    if (decision === "skip") return;

    // Names the pull request too: the same commit can head a pull request opened again later.
    const attemptKey = (headSha: string) => `${link.repository}#${link.number}:${headSha}`;
    const record = (
      kind: string,
      summary: string,
      started?: { headSha: string; attempt: number },
    ) =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso;
        const id = yield* uuid;
        yield* engine.dispatch({
          type: "thread.activity.append",
          commandId: CommandId.make(
            `server:pr-auto-fix:${kind}:${threadId}:${started ? attemptKey(started.headSha) : id}`,
          ),
          threadId,
          activity: {
            id: EventId.make(id),
            tone: "info",
            kind,
            summary,
            payload: { url: link.url, number: link.number, ...started },
            // These records belong to the PR across turns and must survive a chat rewind.
            turnId: null,
            sequence: yield* engine.latestSequence,
            createdAt,
          },
          createdAt,
        });
      });

    if (decision === "passed") return yield* record(activity.passed, "PR checks passed");
    if (decision === "exhausted") return yield* record(activity.exhausted, "PR auto-fix exhausted");

    const threads = yield* snapshots.listThreadsWithPullRequests();
    if (
      threads.some((other) => {
        const earlier = map[other.id];
        return (
          other.id !== threadId &&
          // A settled thread never starts a turn, so it must not hold the PR.
          other.settledOverride !== "settled" &&
          earlier?.enabled &&
          (Date.parse(earlier.setAt) < Date.parse(setting.setAt) ||
            (Date.parse(earlier.setAt) === Date.parse(setting.setAt) && other.id < threadId)) &&
          pullRequestAutoFixTarget(other.pullRequests, other.branch)?.url === link.url
        );
      })
    )
      return;

    const checks = yield* (
      pullRequests.readChecks?.({
        projectId: thread.projectId,
        host: link.host,
        repository: link.repository,
        number: link.number,
      }) ?? Effect.succeed(null)
    ).pipe(
      Effect.tap(() => Effect.sync(() => checkFailures.delete(threadId))),
      Effect.catch(() =>
        Effect.gen(function* () {
          const delay = Math.min(60 * 60_000, (checkFailures.get(threadId)?.delay ?? 30_000) * 2);
          const now = DateTime.toEpochMillis(yield* DateTime.now);
          checkFailures.set(threadId, { delay, retryAt: now + delay });
          retryChecks.add(threadId);
          return null;
        }),
      ),
    );
    if (
      !checks?.open ||
      !checks.headSha ||
      !checks.checks.some((check) => check.status === "failure")
    )
      return;

    // The host read can overlap a user starting work, changing the setting, or replacing the link.
    const current = yield* readCandidate(threadId);
    if (
      current === null ||
      current.setting.setAt !== setting.setAt ||
      current.link.url !== link.url ||
      pullRequestAutoFixDecision(current.link.snapshot?.checksState, current.progress) !==
        "inspect" ||
      current.progress.attemptedHeads.has(checks.headSha)
    )
      return;
    const attempt = current.progress.attempts + 1;
    yield* record(activity.started, "PR auto-fix started", { headSha: checks.headSha, attempt });
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(
        `server:pr-auto-fix-turn:${threadId}:${attemptKey(checks.headSha)}`,
      ),
      threadId,
      message: {
        messageId: MessageId.make(yield* uuid),
        role: "user",
        text: pullRequestAutoFixPrompt(
          link.number,
          current.headBranch,
          checks.headSha,
          attempt,
          checks.checks,
        ),
        attachments: [],
      },
      runtimeMode: current.thread.runtimeMode,
      interactionMode: current.thread.interactionMode,
      createdAt: yield* nowIso,
    });
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    review(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("PR auto-fix review failed", { threadId, cause: Cause.pretty(cause) }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) => {
    if (
      event.type === "thread.pull-request-synced" ||
      (event.type === "thread.session-set" && !isBusy(event.payload.session.status))
    )
      return worker.enqueue(event.payload.threadId);
    return Effect.void;
  };

  const start: PullRequestAutoFixReactor["Service"]["start"] = Effect.fn(
    "PullRequestAutoFixReactor.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const changes = yield* settingsService.subscribeChanges;
    let previous: ServerSettings["threadPullRequestAutoFix"] = {};
    const enqueueChanged = (settings: ServerSettings) =>
      Effect.gen(function* () {
        const next = settings.threadPullRequestAutoFix;
        const before = previous;
        previous = next;
        // Reconsider enabled contenders too: disabling the earlier owner can hand off a PR.
        const changed = [...new Set([...Object.keys(before), ...Object.keys(next)])].some((id) => {
          const key = ThreadId.make(id);
          return (
            before[key]?.enabled !== next[key]?.enabled || before[key]?.setAt !== next[key]?.setAt
          );
        });
        if (!changed) return;
        for (const [id, setting] of Object.entries(next)) {
          if (setting.enabled) yield* worker.enqueue(ThreadId.make(id));
        }
      });

    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* forkParked(
      Effect.gen(function* () {
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const pending = Array.from(retryChecks).filter(
          (id) => now >= (checkFailures.get(id)?.retryAt ?? 0),
        );
        for (const threadId of pending) yield* worker.enqueue(threadId);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      settingsService.getSettings.pipe(
        Effect.matchEffect({ onFailure: () => Effect.void, onSuccess: enqueueChanged }),
        Effect.andThen(Stream.runForEach(changes, enqueueChanged)),
      ),
    );
  });

  return { start, drain: worker.drain };
});

export const layer = Layer.effect(PullRequestAutoFixReactor, make);
