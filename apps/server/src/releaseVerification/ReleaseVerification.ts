import {
  CommandId,
  EventId,
  RELEASE_VERIFICATION_ACTIVITY_KIND,
  RELEASE_VERIFICATION_ERROR_MAX_LENGTH,
  RELEASE_VERIFICATION_REQUIREMENT,
  RELEASE_VERIFICATION_REQUIRED_CHECKS,
  type ReleaseVerificationArtifactNotFoundError,
  ReleaseVerificationAttempt,
  ReleaseVerificationBusyError,
  type ReleaseVerificationGetResult,
  type ReleaseVerificationRunResult,
  ReleaseVerificationThreadNotFoundError,
  ReleaseVerificationUnavailableError,
  releaseVerificationActivityId,
  type ThreadId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as NodeOS from "node:os";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  hashArtifact,
  LAUNCH_MAY_RUN_NOTE,
  locateArtifact,
  macArtifactCapability,
  pendingChecks,
  removeOwnedRunDir,
  resolveTempRoot,
  runMacArtifactChecks,
  runTempDir,
  type RunnerPatch,
} from "./MacArtifactRunner.ts";

/**
 * Runs and records the server-side verification of a thread's macOS build.
 *
 * Only this service writes the record, as a `thread.activity.append` under one
 * fixed id per thread. No client command can carry that activity, so a client
 * can ask for a run and read the outcome but cannot supply one. Each write is a
 * durable event; the projection keeps the newest, which is the current
 * attempt. One attempt runs per server, and an attempt writes only while it is
 * still the registered one.
 */
export class ReleaseVerification extends Context.Service<
  ReleaseVerification,
  {
    /**
     * Reads the thread's record with the server sequence of its row. The file is
     * re-hashed only for a finished attempt made in this server's environment, and
     * the result is reported only if the record did not move on while hashing.
     * Another environment's record stays visible but is never measured or confirmed.
     */
    readonly get: (
      threadId: ThreadId,
    ) => Effect.Effect<ReleaseVerificationGetResult, ReleaseVerificationThreadNotFoundError>;
    /**
     * Returns once the run is registered and recorded as running; the checks
     * continue in the background. A repeat call for the thread whose run is
     * live waits for that same recording and returns its attempt, or fails as
     * unavailable if the run never started.
     */
    readonly run: (
      threadId: ThreadId,
    ) => Effect.Effect<
      ReleaseVerificationRunResult,
      | ReleaseVerificationUnavailableError
      | ReleaseVerificationBusyError
      | ReleaseVerificationArtifactNotFoundError
      | ReleaseVerificationThreadNotFoundError
    >;
    /**
     * Stops the thread's running attempt, waits for its cleanup and its
     * cancelled record, and reports whether there was one to stop.
     */
    readonly cancel: (threadId: ThreadId) => Effect.Effect<boolean>;
    /**
     * Settles attempts a previous server process left running and removes the
     * private folders it owned. Run once at startup, before commands are accepted.
     */
    readonly reconcile: Effect.Effect<void>;
  }
>()("t3/releaseVerification/ReleaseVerification") {}

const decodeAttempt = Schema.decodeUnknownOption(ReleaseVerificationAttempt);

/** A bounded wait for a hash of the file on disk when a client asks whether it still matches. */
const REHASH_TIMEOUT = Duration.seconds(120);
const FINAL_WRITE_TIMEOUT = Duration.seconds(10);
const RESTART_NOTE = "The server restarted while this verification was running.";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type Phase = ReleaseVerificationAttempt["phase"];

const SUMMARIES = {
  running: "Verifying macOS build",
  completed: "macOS build verification finished",
  cancelled: "macOS build verification cancelled",
  interrupted: "macOS build verification interrupted",
  errored: "macOS build verification could not finish",
} as const satisfies Record<Phase, string>;

/**
 * Ends an attempt that will not continue: a check still running was
 * interrupted, one still waiting never ran. The record states what happened;
 * it never leaves a check looking in progress.
 */
export const settleAttempt = (
  attempt: ReleaseVerificationAttempt,
  phase: Exclude<Phase, "running">,
  endedAt: string,
  error: string | null,
): ReleaseVerificationAttempt => ({
  ...attempt,
  phase,
  endedAt,
  error: error === null ? null : error.slice(0, RELEASE_VERIFICATION_ERROR_MAX_LENGTH),
  checks: attempt.checks.map((check) => {
    switch (check.status) {
      case "running":
        return {
          ...check,
          status: "interrupted",
          endedAt,
          detail: `Stopped: verification ${phase}.`,
        };
      case "pending":
        return { ...check, status: "not-run", detail: `Not run: verification ${phase}.` };
      default:
        return check;
    }
  }),
});

const failureText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Verification stopped unexpectedly.";
};

interface LiveRun {
  readonly threadId: ThreadId;
  readonly attemptId: string;
  /**
   * Resolves with the run once it is forked, or null if it never started. A
   * cancel that arrives while the run is still being recorded waits on this.
   */
  readonly started: Deferred.Deferred<Fiber.Fiber<unknown, unknown> | null>;
  readonly cancelRequested: Ref.Ref<boolean>;
}

/** What a `run` finds when it asks for the slot: free, held by this thread's run, or by another's. */
type Claim =
  | { readonly _tag: "claimed" }
  | { readonly _tag: "joined"; readonly run: LiveRun }
  | { readonly _tag: "busy" };

/** What the thread's fixed activity row holds: the attempt and the row's server sequence. */
interface StoredRecord {
  readonly attempt: ReleaseVerificationAttempt;
  readonly sequence: number | undefined;
}

type RecordedEnvironment = ReleaseVerificationAttempt["environment"];

const sameEnvironment = (recorded: RecordedEnvironment, current: RecordedEnvironment) =>
  recorded.environmentId === current.environmentId &&
  recorded.platform === current.platform &&
  recorded.arch === current.arch &&
  recorded.osRelease === current.osRelease &&
  recorded.serverVersion === current.serverVersion;

/** The same stored write: a different attempt, revision, or sequence means something newer landed. */
const sameRecord = (left: StoredRecord, right: StoredRecord) =>
  left.attempt.attemptId === right.attempt.attemptId &&
  left.attempt.revision === right.attempt.revision &&
  left.sequence === right.sequence;

/**
 * Nothing in a record names a launched app's process, so a record that shows the
 * launch step began is never cleaned up by a later server: its folder may be
 * that app's working copy. The status cannot say: the helper also reports
 * "not-run" after a real start (identity anomalies, a pass that was not
 * confirmed gone). The step's start time can: it is set when the step begins,
 * and stays unset for a step that was only ever skipped as "not run: X did not
 * pass". That is conservative, since it also covers a copy that failed before
 * any launch. The folder's own launch marker is checked separately, always, by
 * `removeOwnedRunDir`; this only decides what a record alone can show.
 */
const launchMayHaveStarted = (attempt: ReleaseVerificationAttempt) => {
  const launches = attempt.checks.filter((check) => check.id === "launch-smoke");
  return launches.length !== 1 || launches.some((check) => check.startedAt !== null);
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const activityRepository = yield* ProjectionThreadActivityRepository;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostCapability = macArtifactCapability.pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const live = yield* Ref.make<LiveRun | null>(null);
  const rehashGate = yield* Semaphore.make(1);
  // Runs outlive the RPC that started them but not the server.
  const runScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer(() => Scope.close(runScope, Exit.void));

  const releaseSlot = (attemptId: string) =>
    Ref.update(live, (current) => (current?.attemptId === attemptId ? null : current));

  const writeRecord = (attempt: ReleaseVerificationAttempt) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const at = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:release-verification:${uuid}`),
        threadId: attempt.threadId,
        activity: {
          id: EventId.make(releaseVerificationActivityId(attempt.threadId)),
          tone:
            attempt.phase === "errored" || attempt.checks.some((check) => check.status === "failed")
              ? "error"
              : "info",
          kind: RELEASE_VERIFICATION_ACTIVITY_KIND,
          summary: SUMMARIES[attempt.phase],
          payload: attempt,
          turnId: null,
          // A stable creation time keeps the row's place; `createdAt` below is this write's time.
          createdAt: attempt.startedAt,
        },
        createdAt: at,
      });
    });

  /** A write from an attempt that is no longer the registered one is dropped. */
  const writeIfCurrent = (attempt: ReleaseVerificationAttempt) =>
    Effect.flatMap(Ref.get(live), (current) =>
      current?.attemptId === attempt.attemptId ? writeRecord(attempt) : Effect.void,
    );

  const update = (state: Ref.Ref<ReleaseVerificationAttempt>, patch: RunnerPatch) =>
    Ref.updateAndGet(state, (attempt) => ({
      ...attempt,
      ...patch,
      revision: attempt.revision + 1,
    })).pipe(Effect.flatMap(writeIfCurrent));

  /** Records how the attempt ended. It runs on success, failure, and cancellation alike. */
  const finish = (
    state: Ref.Ref<ReleaseVerificationAttempt>,
    cancelRequested: Ref.Ref<boolean>,
    exit: Exit.Exit<void, unknown>,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      const cancelled = yield* Ref.get(cancelRequested);
      const at = yield* nowIso;
      // The runner reports an error only when it could not clean up after itself.
      const settled =
        current.error !== null
          ? settleAttempt(current, "errored", at, current.error)
          : Exit.isSuccess(exit)
            ? settleAttempt(current, "completed", at, null)
            : Cause.hasInterruptsOnly(exit.cause)
              ? settleAttempt(current, cancelled ? "cancelled" : "interrupted", at, null)
              : settleAttempt(current, "errored", at, failureText(exit.cause));
      const next = { ...settled, revision: current.revision + 1 };
      yield* Ref.set(state, next);
      yield* writeIfCurrent(next).pipe(
        Effect.timeoutOption(FINAL_WRITE_TIMEOUT),
        // The thread may already be gone; the run's cleanup has happened either way.
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to record the release verification outcome", {
            threadId: current.threadId,
            cause,
          }),
        ),
      );
    });

  const resolveRoot = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* query.getThreadShellById(threadId).pipe(Effect.orDie);
    if (Option.isNone(thread)) {
      return yield* new ReleaseVerificationThreadNotFoundError({ threadId });
    }
    const project = yield* query.getProjectShellById(thread.value.projectId).pipe(Effect.orDie);
    if (Option.isNone(project)) {
      return yield* new ReleaseVerificationThreadNotFoundError({ threadId });
    }
    return thread.value.worktreePath ?? project.value.workspaceRoot;
  });

  /** The thread's fixed record as stored right now, with the server sequence of its row. */
  const readRecord = (threadId: ThreadId) =>
    activityRepository
      .listByThreadId({ threadId, activityKinds: [RELEASE_VERIFICATION_ACTIVITY_KIND] })
      .pipe(
        Effect.orDie,
        Effect.map((rows): StoredRecord | null => {
          const row = rows.find(
            (candidate) => candidate.activityId === releaseVerificationActivityId(threadId),
          );
          const attempt = row === undefined ? null : Option.getOrNull(decodeAttempt(row.payload));
          return row !== undefined && attempt?.threadId === threadId
            ? { attempt, sequence: row.sequence }
            : null;
        }),
      );

  /** The environment this server is in now: what a record must match to speak for this host. */
  const currentEnvironment: Effect.Effect<RecordedEnvironment> = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    return {
      environmentId: descriptor.environmentId,
      platform: yield* HostProcessPlatform,
      arch: yield* HostProcessArchitecture,
      osRelease: NodeOS.release(),
      serverVersion: descriptor.serverVersion,
    };
  });

  /**
   * What a reader is shown for a stored record. A `running` record nobody is
   * running (a failed write, a crash) is not shown as running: this process
   * owns every live attempt.
   */
  const presentRecord = Effect.fnUntraced(function* (stored: StoredRecord) {
    const here = yield* currentEnvironment;
    const registered = yield* Ref.get(live);
    const { attempt } = stored;
    return {
      attempt:
        attempt.phase === "running" && registered?.attemptId !== attempt.attemptId
          ? settleAttempt(
              attempt,
              "interrupted",
              yield* nowIso,
              "The server stopped before this verification finished.",
            )
          : attempt,
      environmentMatches: sameEnvironment(attempt.environment, here),
      ...(stored.sequence === undefined ? {} : { sequence: stored.sequence }),
    };
  });

  /**
   * Whether the file at the recorded place still has the recorded content.
   * Content, not metadata: a NAS can change bytes without a reliable mtime.
   * False when it is gone or different, null when it did not finish in time.
   * The bound covers the wait for the hash slot as well as the hash itself, so a
   * read queued behind a slow one cannot wait without limit.
   */
  const matchesRecorded = (
    root: string,
    recorded: NonNullable<ReleaseVerificationAttempt["artifact"]>,
  ) =>
    // One hash at a time, so repeated reads cannot stack up disk work.
    rehashGate
      .withPermit(
        locateArtifact(root).pipe(
          Effect.flatMap((located) =>
            located.workspaceRoot === recorded.workspaceRoot &&
            located.relativePath === recorded.relativePath
              ? hashArtifact(located).pipe(Effect.map((sha256) => sha256 === recorded.sha256))
              : Effect.succeed(false),
          ),
          Effect.orElseSucceed(() => false),
        ),
      )
      .pipe(Effect.timeoutOption(REHASH_TIMEOUT), Effect.map(Option.getOrNull));

  /**
   * The hash is only a statement about the record it was measured against. A
   * newer attempt, revision, or write landing meanwhile (or an attempt that
   * has claimed the slot but not yet been stored) makes it say nothing about
   * what a client is shown now.
   */
  const supersededSince = Effect.fnUntraced(function* (threadId: ThreadId, measured: StoredRecord) {
    const latest = yield* readRecord(threadId);
    const registered = yield* Ref.get(live);
    const newerRun =
      registered !== null &&
      registered.threadId === threadId &&
      registered.attemptId !== measured.attempt.attemptId;
    return newerRun || latest === null || !sameRecord(latest, measured) ? { latest } : null;
  });

  const get: ReleaseVerification["Service"]["get"] = Effect.fn("ReleaseVerification.get")(
    function* (threadId) {
      const capability = yield* hostCapability;
      const root = yield* resolveRoot(threadId);
      const stored = yield* readRecord(threadId);
      if (stored === null) return { capability, attempt: null, artifactUnchanged: null };

      const shown = yield* presentRecord(stored);
      const { attempt } = shown;
      // Another host's or version's proof says nothing about this one, so the
      // record stays visible but the file is not measured against it.
      if (attempt.phase !== "completed" || attempt.artifact === null || !shown.environmentMatches) {
        return { capability, ...shown, artifactUnchanged: null };
      }
      const artifactUnchanged = yield* matchesRecorded(root, attempt.artifact);

      const superseded = yield* supersededSince(threadId, stored);
      if (superseded === null) return { capability, ...shown, artifactUnchanged };
      // Show the current record, unmeasured: never the old hash result on a new record.
      return superseded.latest === null
        ? { capability, attempt: null, artifactUnchanged: null }
        : { capability, ...(yield* presentRecord(superseded.latest)), artifactUnchanged: null };
    },
  );

  const run: ReleaseVerification["Service"]["run"] = Effect.fn("ReleaseVerification.run")(
    function* (threadId) {
      const capability = yield* hostCapability;
      if (!capability.available) {
        return yield* new ReleaseVerificationUnavailableError({
          reason: capability.reason ?? "Release verification is not supported on this server.",
        });
      }
      const root = yield* resolveRoot(threadId);
      const located = yield* locateArtifact(root);
      const tempRoot = yield* resolveTempRoot(runTempDir(yield* HostProcessPlatform)).pipe(
        Effect.mapError(
          (error) => new ReleaseVerificationUnavailableError({ reason: error.message }),
        ),
      );
      const attemptId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      const initial: ReleaseVerificationAttempt = {
        threadId,
        attemptId,
        revision: 0,
        requirement: RELEASE_VERIFICATION_REQUIREMENT,
        checkSet: [...RELEASE_VERIFICATION_REQUIRED_CHECKS],
        environment: yield* currentEnvironment,
        artifact: null,
        runDir: null,
        phase: "running",
        checks: pendingChecks(),
        startedAt: yield* nowIso,
        endedAt: null,
        error: null,
      };

      const state = yield* Ref.make(initial);
      const cancelRequested = yield* Ref.make(false);
      const started = yield* Deferred.make<Fiber.Fiber<unknown, unknown> | null>();
      // The claim and the handler that frees it are one uninterruptible region: an interrupt
      // between them would leave the slot taken. Only a joiner's wait is made interruptible again.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // One step decides all three outcomes, so a call never acts on a slot that changed after it looked.
          const claim = yield* Ref.modify(live, (current): readonly [Claim, LiveRun | null] => {
            if (current === null) {
              return [{ _tag: "claimed" }, { threadId, attemptId, started, cancelRequested }];
            }
            return [
              current.threadId === threadId ? { _tag: "joined", run: current } : { _tag: "busy" },
              current,
            ];
          });
          if (claim._tag === "busy") return yield* new ReleaseVerificationBusyError();
          if (claim._tag === "joined") {
            // The attempt is only reported once its first record is stored and its checks have
            // started. A joiner that is interrupted while waiting leaves the run and its slot alone.
            const fiber = yield* restore(Deferred.await(claim.run.started));
            if (fiber === null) {
              return yield* new ReleaseVerificationUnavailableError({
                reason: "The verification that was already starting could not be recorded.",
              });
            }
            return { attemptId: claim.run.attemptId };
          }

          return yield* Effect.gen(function* () {
            yield* writeRecord(initial).pipe(Effect.orDie);
            const fiber = yield* runMacArtifactChecks({
              attemptId,
              artifact: located,
              tempRoot,
              onUpdate: (patch) => update(state, patch),
            }).pipe(
              Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
              // Cleanup and the final write come first; only then is the slot given back.
              Effect.onExit((exit) => finish(state, cancelRequested, exit)),
              Effect.ensuring(releaseSlot(attemptId)),
              // A forked fiber does not inherit this block's uninterruptibility unless asked to:
              // the checks stay cancellable. It starts at once so its cleanup is in place before
              // any cancel can reach it.
              Effect.forkIn(runScope, { startImmediately: true, uninterruptible: false }),
            );
            yield* Deferred.succeed(started, fiber);
            return { attemptId };
          }).pipe(
            // Nothing started: free the slot and tell a waiting cancel there is nothing to stop.
            Effect.onError(() =>
              Effect.andThen(releaseSlot(attemptId), Deferred.succeed(started, null)),
            ),
          );
        }),
      );
    },
  );

  const cancel: ReleaseVerification["Service"]["cancel"] = (threadId) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(live);
      if (current === null || current.threadId !== threadId) return false;
      yield* Ref.set(current.cancelRequested, true);
      // A cancel that lands while the run is still being recorded waits for it to start.
      const fiber = yield* Deferred.await(current.started);
      if (fiber === null) return false;
      // Returns after the run has unmounted, cleaned up, written its outcome, and freed the slot.
      yield* Fiber.interrupt(fiber);
      return true;
    });

  const reconcile: ReleaseVerification["Service"]["reconcile"] = Effect.gen(function* () {
    const recorded = yield* query
      .listActivitiesByKind(RELEASE_VERIFICATION_ACTIVITY_KIND)
      .pipe(Effect.orDie);
    const tempRoot = yield* resolveTempRoot(runTempDir(yield* HostProcessPlatform)).pipe(
      Effect.option,
    );

    for (const row of recorded) {
      const attempt = Option.getOrNull(decodeAttempt(row.payload));
      if (attempt === null || row.id !== releaseVerificationActivityId(attempt.threadId)) continue;
      const wasRunning = attempt.phase === "running";
      // A settled record still holding a folder means an earlier cleanup failed; try again.
      if (!wasRunning && attempt.runDir === null) continue;

      // A launched app is a process this server cannot name, so no restart may detach the
      // image by force or delete the folder under it. The record is settled as interrupted
      // and the folder stays as evidence for a person to recover; nothing is killed or rerun.
      const mayOwnApp = attempt.runDir !== null && launchMayHaveStarted(attempt);
      const problem =
        attempt.runDir === null
          ? null
          : mayOwnApp
            ? LAUNCH_MAY_RUN_NOTE
            : yield* removeOwnedRunDir(
                attempt,
                Option.getOrElse(tempRoot, () => ""),
              ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, processRunner));
      if (!wasRunning && problem !== null) continue;

      const at = yield* nowIso;
      const base = wasRunning
        ? settleAttempt(
            attempt,
            "interrupted",
            at,
            problem === null ? RESTART_NOTE : `${RESTART_NOTE} ${problem}`,
          )
        : attempt;
      yield* writeRecord({
        ...base,
        revision: attempt.revision + 1,
        runDir: problem === null ? null : attempt.runDir,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to settle an interrupted release verification", {
            threadId: attempt.threadId,
            cause,
          }),
        ),
      );
    }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) => Effect.logWarning("release verification startup reconciliation failed", { cause }),
    ),
  );

  return ReleaseVerification.of({ get, run, cancel, reconcile });
});

export const layer = Layer.effect(ReleaseVerification, make).pipe(
  Layer.provide(ProjectionThreadActivityRepositoryLive),
  Layer.provide(ProcessRunner.layer),
);
