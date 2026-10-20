import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  type OrchestrationCommand,
  ProjectId,
  RELEASE_VERIFICATION_ACTIVITY_KIND,
  RELEASE_VERIFICATION_REQUIRED_CHECKS,
  RELEASE_VERIFICATION_REQUIREMENT,
  ReleaseVerificationArtifactNotFoundError,
  ReleaseVerificationAttempt,
  ReleaseVerificationBusyError,
  type ReleaseVerificationCheck,
  ReleaseVerificationThreadNotFoundError,
  ReleaseVerificationUnavailableError,
  ThreadId,
  deriveReleaseVerificationState,
  releaseVerificationActivityId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
} from "../persistence/Services/ProjectionThreadActivities.ts";
import * as ProcessRunner from "../processRunner.ts";
import {
  encodeJson,
  makeFakeMacTools,
  makeReleaseWorkspace,
  RELEASE_TEST_DMG_CONTENTS,
  RELEASE_TEST_VERSION,
  type FakeMacTools,
} from "../testUtils/fakeMacTools.ts";
import { LAUNCH_MAY_RUN_NOTE, runTempDir } from "./MacArtifactRunner.ts";
import { LAUNCH_UNCONFIRMED_MARKER } from "./MacLaunchSmoke.ts";
import * as ReleaseVerification from "./ReleaseVerification.ts";

const threadId = ThreadId.make("thread-1");
const startedAt = "2026-08-20T12:00:00.000Z";

const decodeAttempt = Schema.decodeUnknownSync(ReleaseVerificationAttempt);

const attemptsFrom = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched.flatMap((command) =>
    command.type === "thread.activity.append" ? [decodeAttempt(command.activity.payload)] : [],
  );

/** Images mounted so far: one per run that actually started. */
const mountsOf = (tools: FakeMacTools) =>
  tools.calls.filter((call) => call.name === "hdiutil" && call.args[0] === "attach").length;

/** The service reads the host from references; these make the test host a supported Mac. */
const asHost =
  (platform: NodeJS.Platform, isAvailable: (tool: string) => boolean = () => true) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, platform),
      Effect.provideService(HostProcessArchitecture, "arm64"),
      Effect.provideService(CommandAvailability, (tool) => Effect.succeed(isAvailable(tool))),
    );
const asMac = asHost("darwin");

/**
 * The service under test with a stand-in for the engine and projection: a
 * dispatched activity upserts a row by id, like the real projection, so what
 * `get` reads is what the last write left. `settled(attemptId)` resolves when
 * that attempt writes its first non-running record.
 */
const makeHarness = (options: {
  readonly workspaceRoot: string;
  readonly tools: FakeMacTools;
  readonly threadExists?: boolean;
  readonly seed?: ReadonlyArray<ProjectionThreadActivity>;
  /** Runs at the start of each write, before it is stored; a gate here holds that write open. */
  readonly onDispatch?: (writeNumber: number, command: OrchestrationCommand) => Effect.Effect<void>;
  /** Runs at the start of each read of the record; a gate here parks a `get` between its reads. */
  readonly onRead?: Effect.Effect<void>;
  /**
   * Runs at the start of each read of the server's descriptor. A `run` reads it once, as its
   * last step before asking for the slot, so a receipt here marks a call that is about to ask.
   */
  readonly onDescriptor?: (readNumber: number) => Effect.Effect<void>;
}) => {
  const dispatched: Array<OrchestrationCommand> = [];
  let descriptorReads = 0;
  const rows = new Map<string, ProjectionThreadActivity>(
    (options.seed ?? []).map((row) => [row.activityId, row]),
  );
  const waiters = new Map<string, Deferred.Deferred<ReleaseVerificationAttempt>>();
  const settled = (attemptId: string) => {
    const existing = waiters.get(attemptId);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<ReleaseVerificationAttempt>();
    waiters.set(attemptId, created);
    return created;
  };

  const layer = Layer.effect(
    ReleaseVerification.ReleaseVerification,
    ReleaseVerification.make,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              yield* options.onDispatch?.(dispatched.length + 1, command) ?? Effect.void;
              dispatched.push(command);
              // Like the projection: the row keeps the server sequence of the write that made it.
              const sequence = dispatched.length;
              if (command.type === "thread.activity.append") {
                const attempt = decodeAttempt(command.activity.payload);
                rows.set(command.activity.id, {
                  activityId: command.activity.id,
                  threadId: command.threadId,
                  turnId: null,
                  tone: command.activity.tone,
                  kind: command.activity.kind,
                  summary: command.activity.summary,
                  payload: structuredClone(command.activity.payload),
                  sequence,
                  createdAt: command.activity.createdAt,
                });
                if (attempt.phase !== "running") {
                  yield* Deferred.succeed(settled(attempt.attemptId), attempt);
                }
              }
              return { sequence };
            }),
        }),
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getThreadShellById: (id) =>
            Effect.succeed(
              options.threadExists === false
                ? Option.none()
                : Option.some({
                    id,
                    projectId: ProjectId.make("project-1"),
                    worktreePath: null,
                  } as never),
            ),
          getProjectShellById: () =>
            Effect.succeedSome({ workspaceRoot: options.workspaceRoot } as never),
          listActivitiesByKind: (kind) =>
            Effect.succeed(
              [...rows.values()]
                .filter((row) => row.kind === kind)
                .map((row) => ({
                  id: row.activityId,
                  tone: row.tone,
                  kind: row.kind,
                  summary: row.summary,
                  payload: row.payload,
                  turnId: null,
                  createdAt: row.createdAt,
                })),
            ),
        }),
        Layer.mock(ProjectionThreadActivityRepository)({
          listByThreadId: (input) =>
            Effect.gen(function* () {
              yield* options.onRead ?? Effect.void;
              return [...rows.values()].filter(
                (row) =>
                  row.threadId === input.threadId &&
                  (input.activityKinds === undefined || input.activityKinds.includes(row.kind)),
              );
            }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.suspend(() =>
            (options.onDescriptor?.(++descriptorReads) ?? Effect.void).pipe(
              Effect.as({
                environmentId: EnvironmentId.make("environment-1"),
                serverVersion: "0.0.45",
              } as never),
            ),
          ),
        }),
        Layer.succeed(ProcessRunner.ProcessRunner, options.tools.processRunner),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

  return { layer, dispatched, rows, settled };
};

/** What the harness reports as this host: its descriptor, the darwin/arm64 override, the real OS. */
const hereEnvironment: ReleaseVerificationAttempt["environment"] = {
  environmentId: EnvironmentId.make("environment-1"),
  platform: "darwin",
  arch: "arm64",
  osRelease: NodeOS.release(),
  serverVersion: "0.0.45",
};

const passedChecks = (): Array<ReleaseVerificationCheck> =>
  RELEASE_VERIFICATION_REQUIRED_CHECKS.map((id) => ({
    id,
    status: "passed",
    startedAt: null,
    endedAt: null,
    exitCode: 0,
    detail: null,
    tail: [],
  }));

const attemptSeed = (
  overrides: Partial<ReleaseVerificationAttempt> = {},
): ReleaseVerificationAttempt => ({
  threadId,
  attemptId: "attempt-seed",
  revision: 2,
  requirement: {
    id: RELEASE_VERIFICATION_REQUIREMENT.id,
    version: RELEASE_VERIFICATION_REQUIREMENT.version,
  },
  checkSet: [...RELEASE_VERIFICATION_REQUIRED_CHECKS],
  environment: { ...hereEnvironment },
  artifact: null,
  runDir: null,
  phase: "running",
  checks: RELEASE_VERIFICATION_REQUIRED_CHECKS.map((id, index): ReleaseVerificationCheck => ({
    id,
    status: index === 0 ? "passed" : index === 1 ? "running" : "pending",
    startedAt: null,
    endedAt: null,
    exitCode: null,
    detail: null,
    tail: [],
  })),
  startedAt,
  endedAt: null,
  error: null,
  ...overrides,
});

const rowFor = (
  attempt: ReleaseVerificationAttempt,
  sequence?: number,
): ProjectionThreadActivity => ({
  activityId: EventId.make(releaseVerificationActivityId(attempt.threadId)),
  threadId: attempt.threadId,
  turnId: null,
  tone: "info",
  kind: RELEASE_VERIFICATION_ACTIVITY_KIND,
  summary: "Verifying macOS build",
  payload: structuredClone(attempt),
  ...(sequence === undefined ? {} : { sequence }),
  createdAt: attempt.startedAt,
});

/**
 * Gates for a run whose first record is held open while a repeat call reaches the slot. They
 * are receipts, not delays: `writing` says the slot is claimed with nothing stored yet, and
 * `callerReady` says the repeat call has read the host, its last step before it asks for the
 * slot. The held write then ends in `afterRelease`: success unless the test makes it fail.
 */
const makeHeldFirstWrite = (afterRelease: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>();
    const finishWrite = yield* Deferred.make<void>();
    const callerReady = yield* Deferred.make<void>();
    const held = { armed: true };
    // A test that fails while the write is held must not leave the run stuck behind it.
    yield* Effect.addFinalizer(() => Deferred.succeed(finishWrite, undefined));
    return {
      writing,
      finishWrite,
      onDispatch: () =>
        Effect.suspend(() => {
          if (!held.armed) return Effect.void;
          held.armed = false;
          return Deferred.succeed(writing, undefined).pipe(
            Effect.andThen(Deferred.await(finishWrite)),
            Effect.andThen(afterRelease),
          );
        }),
      onDescriptor: (readNumber: number) =>
        readNumber === 2 ? Deferred.succeed(callerReady, undefined) : Effect.void,
      /** The run, then a repeat call for the same thread that is waiting for its first record. */
      startWithRepeat: (service: ReleaseVerification.ReleaseVerification["Service"]) =>
        Effect.gen(function* () {
          const starting = yield* service.run(threadId).pipe(Effect.forkChild);
          yield* Deferred.await(writing);
          const repeating = yield* service.run(threadId).pipe(Effect.forkChild);
          yield* Deferred.await(callerReady);
          // One yield lets the repeat call, which is runnable, reach its wait.
          yield* Effect.yieldNow;
          return { starting, repeating };
        }),
    };
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("ReleaseVerification", (it) => {
  describe("run", () => {
    it.effect(
      "records a full run, the way the projection will keep it, and never calls it verified",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspace = yield* makeReleaseWorkspace();
          const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
          const harness = makeHarness({ workspaceRoot: workspace.root, tools });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const { attemptId } = yield* service.run(threadId);
            yield* Deferred.await(harness.settled(attemptId));

            const records = attemptsFrom(harness.dispatched);
            const [first] = records;
            const last = records.at(-1);
            expect(first).toMatchObject({
              attemptId,
              revision: 0,
              phase: "running",
              artifact: null,
              runDir: null,
            });
            expect(first?.checks.every((check) => check.status === "pending")).toBe(true);
            // Each write of the attempt is newer than the one before it.
            expect(records.map((record) => record.revision)).toEqual(
              records.map((_, index) => index),
            );
            expect(new Set(records.map((record) => record.attemptId))).toEqual(
              new Set([attemptId]),
            );
            expect(last).toMatchObject({ phase: "completed", runDir: null, error: null });
            expect(last?.checks.map((check) => check.status)).toEqual([
              "passed",
              "passed",
              "passed",
              "passed",
              "passed",
              "not-run",
            ]);
            expect(last?.artifact?.sha256).toBe(
              NodeCrypto.createHash("sha256").update(RELEASE_TEST_DMG_CONTENTS).digest("hex"),
            );
            expect(last?.environment).toMatchObject({
              environmentId: "environment-1",
              platform: "darwin",
              serverVersion: "0.0.45",
            });

            // Every record is one fixed activity, appended by the server, outside any turn.
            const appended = harness.dispatched.flatMap((command) =>
              command.type === "thread.activity.append" ? [command] : [],
            );
            expect(appended).toHaveLength(harness.dispatched.length);
            for (const command of appended) {
              expect(command.threadId).toBe(threadId);
              expect(command.activity).toMatchObject({
                id: releaseVerificationActivityId(threadId),
                kind: RELEASE_VERIFICATION_ACTIVITY_KIND,
                turnId: null,
              });
            }

            const result = yield* service.get(threadId);
            expect(result.artifactUnchanged).toBe(true);
            const derived = deriveReleaseVerificationState(result);
            expect(derived.state).toBe("needs-confirmation");
            expect(derived.reasons).toContain("App startup: not run");

            // Content decides, not size or time: same length, different bytes.
            yield* fileSystem.writeFileString(
              workspace.dmgPath,
              RELEASE_TEST_DMG_CONTENTS.toUpperCase(),
            );
            expect((yield* service.get(threadId)).artifactUnchanged).toBe(false);
            yield* fileSystem.remove(workspace.dmgPath);
            expect((yield* service.get(threadId)).artifactUnchanged).toBe(false);
          }).pipe(Effect.provide(harness.layer), asMac);

          // The private folder is gone once the run settled.
          const runDir = attemptsFrom(harness.dispatched).find(
            (record) => record.runDir !== null,
          )?.runDir;
          expect(runDir).toBeDefined();
          expect(yield* fileSystem.exists(runDir ?? "")).toBe(false);
          // One short folder under the Mac temp directory: the launched app's Unix sockets live
          // below it and macOS caps their paths at 103 bytes.
          const macTemp = yield* fileSystem.realPath("/tmp");
          expect(runDir?.startsWith(`${macTemp}/t3v-`)).toBe(true);
          expect(Buffer.byteLength(runDir ?? "")).toBeLessThanOrEqual(54);
        }),
    );

    it.effect("a failing check is recorded as failed and the state follows", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION, verifyExit: 1 });
        const harness = makeHarness({ workspaceRoot: workspace.root, tools });

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const { attemptId } = yield* service.run(threadId);
          yield* Deferred.await(harness.settled(attemptId));

          const result = yield* service.get(threadId);
          expect(result.attempt?.phase).toBe("completed");
          expect(deriveReleaseVerificationState(result).state).toBe("failed");
          const last = harness.dispatched.at(-1);
          expect(last?.type === "thread.activity.append" && last.activity.tone).toBe("error");
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect(
      "refuses a second run while one is active, then cancel stops it before it records",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspace = yield* makeReleaseWorkspace();
          const reachedCodesign = yield* Deferred.make<void>();
          const tools = makeFakeMacTools({
            version: RELEASE_TEST_VERSION,
            onCodesign: Deferred.succeed(reachedCodesign, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          });
          const harness = makeHarness({ workspaceRoot: workspace.root, tools });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const { attemptId } = yield* service.run(threadId);
            yield* Deferred.await(reachedCodesign);
            const writesWhileRunning = harness.dispatched.length;

            // Busy covers every thread, and a refused run writes nothing.
            const busy = yield* service.run(ThreadId.make("thread-2")).pipe(Effect.flip);
            expect(busy).toBeInstanceOf(ReleaseVerificationBusyError);
            expect(harness.dispatched).toHaveLength(writesWhileRunning);

            // A thread with nothing running has nothing to cancel.
            expect(yield* service.cancel(ThreadId.make("thread-2"))).toBe(false);
            expect(yield* service.cancel(threadId)).toBe(true);
            expect(yield* service.cancel(threadId)).toBe(false);

            const records = attemptsFrom(harness.dispatched);
            const folder = records.find((record) => record.runDir !== null)?.runDir ?? "";
            const last = records.at(-1);
            expect(last).toMatchObject({ attemptId, phase: "cancelled", runDir: null });
            expect(last?.endedAt).not.toBeNull();
            expect(last?.checks.map((check) => check.status)).toEqual([
              "passed",
              "passed",
              "passed",
              "passed",
              "interrupted",
              "not-run",
            ]);
            // Cleanup was recorded before the cancelled outcome, and the folder is gone.
            expect(records.at(-2)).toMatchObject({ phase: "running", runDir: null });
            expect(yield* fileSystem.exists(folder)).toBe(false);

            const result = yield* service.get(threadId);
            const derived = deriveReleaseVerificationState(result);
            expect(derived.state).toBe("needs-confirmation");
            expect(derived.reasons).toContain("Verification was cancelled");
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect(
      "a repeat run on the thread whose run is live joins it: one run, no extra records",
      () =>
        Effect.gen(function* () {
          const workspace = yield* makeReleaseWorkspace();
          const reachedCodesign = yield* Deferred.make<void>();
          const tools = makeFakeMacTools({
            version: RELEASE_TEST_VERSION,
            onCodesign: Deferred.succeed(reachedCodesign, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          });
          const harness = makeHarness({ workspaceRoot: workspace.root, tools });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const first = yield* service.run(threadId);
            yield* Deferred.await(reachedCodesign);
            const writesAfterStart = harness.dispatched.length;

            const second = yield* service.run(threadId);
            expect(second.attemptId).toBe(first.attemptId);
            expect(harness.dispatched).toHaveLength(writesAfterStart);
            expect(mountsOf(tools)).toBe(1);

            // The one run is the one cancelled: a single cancelled record, then a free slot.
            expect(yield* service.cancel(threadId)).toBe(true);
            expect(yield* service.cancel(threadId)).toBe(false);
            const records = attemptsFrom(harness.dispatched);
            expect(new Set(records.map((record) => record.attemptId))).toEqual(
              new Set([first.attemptId]),
            );
            expect(records.filter((record) => record.phase === "cancelled")).toHaveLength(1);
            expect(records.at(-1)?.phase).toBe("cancelled");
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect(
      "after a run ends, by finishing or by cancel, the next run is a fresh attempt that owns the slot",
      () =>
        Effect.gen(function* () {
          const workspace = yield* makeReleaseWorkspace();
          // The first run finishes; once `hold` is on, every later one hangs until it is cancelled.
          const hold = { on: false };
          const tools = makeFakeMacTools({
            version: RELEASE_TEST_VERSION,
            onCodesign: Effect.suspend(() => (hold.on ? Effect.never : Effect.void)),
          });
          const harness = makeHarness({ workspaceRoot: workspace.root, tools });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const first = yield* service.run(threadId);
            yield* Deferred.await(harness.settled(first.attemptId));
            // A cancel returns only once the slot is free, whether or not it had a run to stop.
            yield* service.cancel(threadId);
            hold.on = true;

            const second = yield* service.run(threadId);
            expect(second.attemptId).not.toBe(first.attemptId);
            // The new attempt holds the slot: another thread is refused.
            const busy = yield* service.run(ThreadId.make("thread-2")).pipe(Effect.flip);
            expect(busy).toBeInstanceOf(ReleaseVerificationBusyError);
            expect(yield* service.cancel(threadId)).toBe(true);

            const third = yield* service.run(threadId);
            expect(third.attemptId).not.toBe(second.attemptId);
            expect(yield* service.cancel(threadId)).toBe(true);

            const ended = attemptsFrom(harness.dispatched)
              .filter((record) => record.phase !== "running")
              .map((record) => [record.attemptId, record.phase]);
            expect(ended).toEqual([
              [first.attemptId, "completed"],
              [second.attemptId, "cancelled"],
              [third.attemptId, "cancelled"],
            ]);
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect(
      "a repeat run during the first record's write reports the attempt only once it is stored",
      () =>
        Effect.gen(function* () {
          const workspace = yield* makeReleaseWorkspace();
          const gates = yield* makeHeldFirstWrite();
          // The run can only end by being cancelled: its codesign never returns.
          const tools = makeFakeMacTools({
            version: RELEASE_TEST_VERSION,
            onCodesign: Effect.never,
          });
          const harness = makeHarness({
            workspaceRoot: workspace.root,
            tools,
            onDispatch: gates.onDispatch,
            onDescriptor: gates.onDescriptor,
          });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const { starting, repeating } = yield* gates.startWithRepeat(service);
            // Nothing is stored, so the repeat call has no attempt to report yet.
            expect(harness.dispatched).toEqual([]);
            expect(repeating.pollUnsafe()).toBeUndefined();

            yield* Deferred.succeed(gates.finishWrite, undefined);
            const started = yield* Fiber.join(starting);
            expect(yield* Fiber.join(repeating)).toEqual(started);
            // What it reported was stored first, and no second attempt exists.
            expect(attemptsFrom(harness.dispatched)[0]).toMatchObject({
              attemptId: started.attemptId,
              phase: "running",
            });

            expect(yield* service.cancel(threadId)).toBe(true);
            const records = attemptsFrom(harness.dispatched);
            expect(new Set(records.map((record) => record.attemptId))).toEqual(
              new Set([started.attemptId]),
            );
            expect(records.filter((record) => record.phase === "cancelled")).toHaveLength(1);
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect(
      "a repeat run waiting on a first record that cannot be stored fails, and the slot is freed",
      () =>
        Effect.gen(function* () {
          const workspace = yield* makeReleaseWorkspace();
          // The first write fails once it is released; later writes succeed.
          const gates = yield* makeHeldFirstWrite(
            Effect.die(new Error("the record could not be stored")),
          );
          const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
          const harness = makeHarness({
            workspaceRoot: workspace.root,
            tools,
            onDispatch: gates.onDispatch,
            onDescriptor: gates.onDescriptor,
          });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const { starting, repeating } = yield* gates.startWithRepeat(service);
            yield* Deferred.succeed(gates.finishWrite, undefined);

            expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true);
            // Not a success naming an attempt that was never stored.
            const refused = yield* Fiber.await(repeating);
            expect(Exit.isFailure(refused) && Cause.squash(refused.cause)).toBeInstanceOf(
              ReleaseVerificationUnavailableError,
            );
            expect(harness.dispatched).toEqual([]);

            // The slot is free: nothing to cancel, and a new run starts and finishes.
            expect(yield* service.cancel(threadId)).toBe(false);
            const next = yield* service.run(threadId);
            const ended = yield* Deferred.await(harness.settled(next.attemptId));
            expect(ended.phase).toBe("completed");
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect("a repeat run interrupted while it waits leaves the run and its slot alone", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const gates = yield* makeHeldFirstWrite();
        const reachedCodesign = yield* Deferred.make<void>();
        const tools = makeFakeMacTools({
          version: RELEASE_TEST_VERSION,
          onCodesign: Deferred.succeed(reachedCodesign, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        });
        const harness = makeHarness({
          workspaceRoot: workspace.root,
          tools,
          onDispatch: gates.onDispatch,
          onDescriptor: gates.onDescriptor,
        });

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const { starting, repeating } = yield* gates.startWithRepeat(service);
          yield* Fiber.interrupt(repeating);

          yield* Deferred.succeed(gates.finishWrite, undefined);
          const { attemptId } = yield* Fiber.join(starting);
          yield* Deferred.await(reachedCodesign);
          // The run is intact and still holds the slot.
          const busy = yield* service.run(ThreadId.make("thread-2")).pipe(Effect.flip);
          expect(busy).toBeInstanceOf(ReleaseVerificationBusyError);

          expect(yield* service.cancel(threadId)).toBe(true);
          expect(yield* service.cancel(threadId)).toBe(false);
          const records = attemptsFrom(harness.dispatched);
          expect(new Set(records.map((record) => record.attemptId))).toEqual(new Set([attemptId]));
          expect(records.filter((record) => record.phase === "cancelled")).toHaveLength(1);
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect(
      "a run interrupted while its first record is written still starts, and a waiting repeat call gets it",
      () =>
        Effect.gen(function* () {
          const workspace = yield* makeReleaseWorkspace();
          const gates = yield* makeHeldFirstWrite();
          const reachedCodesign = yield* Deferred.make<void>();
          const tools = makeFakeMacTools({
            version: RELEASE_TEST_VERSION,
            onCodesign: Deferred.succeed(reachedCodesign, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
          });
          const harness = makeHarness({
            workspaceRoot: workspace.root,
            tools,
            onDispatch: gates.onDispatch,
            onDescriptor: gates.onDescriptor,
          });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const { starting, repeating } = yield* gates.startWithRepeat(service);
            // The slot is claimed, so the interrupt waits until the run is recorded and started.
            const interrupting = yield* Fiber.interrupt(starting).pipe(
              Effect.forkChild({ startImmediately: true }),
            );
            yield* Deferred.succeed(gates.finishWrite, undefined);
            yield* Fiber.join(interrupting);
            expect(Exit.isFailure(yield* Fiber.await(starting))).toBe(true);

            const { attemptId } = yield* Fiber.join(repeating);
            expect(attemptsFrom(harness.dispatched)[0]?.attemptId).toBe(attemptId);
            yield* Deferred.await(reachedCodesign);
            const busy = yield* service.run(ThreadId.make("thread-2")).pipe(Effect.flip);
            expect(busy).toBeInstanceOf(ReleaseVerificationBusyError);

            expect(yield* service.cancel(threadId)).toBe(true);
            expect(yield* service.cancel(threadId)).toBe(false);
            const records = attemptsFrom(harness.dispatched);
            expect(new Set(records.map((record) => record.attemptId))).toEqual(
              new Set([attemptId]),
            );
            expect(records.filter((record) => record.phase === "cancelled")).toHaveLength(1);
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect("an older attempt cannot overwrite a newer one's record", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const reachedCodesign = yield* Deferred.make<void>();
        const blocking = { on: true };
        const tools = makeFakeMacTools({
          version: RELEASE_TEST_VERSION,
          onCodesign: Effect.suspend(() =>
            blocking.on
              ? Deferred.succeed(reachedCodesign, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.void,
          ),
        });
        const harness = makeHarness({ workspaceRoot: workspace.root, tools });

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const first = yield* service.run(threadId);
          yield* Deferred.await(reachedCodesign);
          expect(yield* service.cancel(threadId)).toBe(true);

          blocking.on = false;
          const second = yield* service.run(threadId);
          yield* Deferred.await(harness.settled(second.attemptId));

          const owners = attemptsFrom(harness.dispatched).map((record) => record.attemptId);
          const firstSecond = owners.indexOf(second.attemptId);
          expect(firstSecond).toBeGreaterThan(0);
          // Nothing from the first attempt is written after the second began.
          expect(owners.slice(firstSecond).every((owner) => owner === second.attemptId)).toBe(true);
          expect(owners.slice(0, firstSecond).every((owner) => owner === first.attemptId)).toBe(
            true,
          );

          const kept = (yield* service.get(threadId)).attempt;
          expect(kept).toMatchObject({ attemptId: second.attemptId, phase: "completed" });
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    // The service runs the checks with the native mount check, which compares device ids. The
    // fake tools build their "mounted" app on the folder's own filesystem, so here nothing ever
    // reads as mounted and no detach happens: unmount-before-delete is proven in the runner
    // tests, which inject the mount check. This test covers what the service adds on top: the
    // folder is already gone, but the cancel, the slot, and the outcome wait for the final write.
    it.effect(
      "a cancel returns only after the final record is stored, and nothing overlaps it",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspace = yield* makeReleaseWorkspace();
          const reachedCodesign = yield* Deferred.make<void>();
          const reachedFinalWrite = yield* Deferred.make<void>();
          const finishFinalWrite = yield* Deferred.make<void>();
          const hold = { on: true };
          // The check hangs until cancelled.
          const tools = makeFakeMacTools({
            version: RELEASE_TEST_VERSION,
            onCodesign: Effect.suspend(() =>
              hold.on
                ? Deferred.succeed(reachedCodesign, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.void,
            ),
          });
          const harness = makeHarness({
            workspaceRoot: workspace.root,
            tools,
            // Holds the cancelled outcome's write open, after the run's cleanup was recorded.
            onDispatch: (_writeNumber, command) =>
              command.type === "thread.activity.append" &&
              decodeAttempt(command.activity.payload).phase === "cancelled"
                ? Deferred.succeed(reachedFinalWrite, undefined).pipe(
                    Effect.andThen(Deferred.await(finishFinalWrite)),
                  )
                : Effect.void,
          });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const { attemptId } = yield* service.run(threadId);
            yield* Deferred.await(reachedCodesign);

            const cancelReturned = yield* Ref.make(false);
            const cancelling = yield* service.cancel(threadId).pipe(
              Effect.tap(() => Ref.set(cancelReturned, true)),
              Effect.forkChild,
            );
            // The cancel interrupted the hung check and cleanup ran; the outcome write is held.
            yield* Deferred.await(reachedFinalWrite);

            const heldRecords = attemptsFrom(harness.dispatched);
            const folder = heldRecords.find((record) => record.runDir !== null)?.runDir ?? "";
            expect(folder).not.toBe("");
            // Cleanup is done and was recorded, but the attempt is not yet reported as ended.
            expect(heldRecords.at(-1)).toMatchObject({
              attemptId,
              phase: "running",
              runDir: null,
            });
            expect(yield* fileSystem.exists(folder)).toBe(false);
            expect(yield* Ref.get(cancelReturned)).toBe(false);
            // The slot stays taken until the outcome is stored.
            const overlapping = yield* service.run(ThreadId.make("thread-2")).pipe(Effect.flip);
            expect(overlapping).toBeInstanceOf(ReleaseVerificationBusyError);

            hold.on = false;
            yield* Deferred.succeed(finishFinalWrite, undefined);
            expect(yield* Fiber.join(cancelling)).toBe(true);
            expect(attemptsFrom(harness.dispatched).at(-1)).toMatchObject({
              attemptId,
              phase: "cancelled",
              runDir: null,
            });

            // Once the cancel has returned the slot is free.
            const next = yield* service.run(ThreadId.make("thread-2"));
            yield* Deferred.await(harness.settled(next.attemptId));
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect(
      "a cancel that lands while the run is still being recorded waits for it, then stops it",
      () =>
        Effect.gen(function* () {
          const workspace = yield* makeReleaseWorkspace();
          const writing = yield* Deferred.make<void>();
          const finishWrite = yield* Deferred.make<void>();
          // The run can only end by being cancelled: its codesign never returns.
          const tools = makeFakeMacTools({
            version: RELEASE_TEST_VERSION,
            onCodesign: Effect.never,
          });
          const harness = makeHarness({
            workspaceRoot: workspace.root,
            tools,
            onDispatch: (writeNumber) =>
              writeNumber === 1
                ? Deferred.succeed(writing, undefined).pipe(
                    Effect.andThen(Deferred.await(finishWrite)),
                  )
                : Effect.void,
          });

          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const starting = yield* service.run(threadId).pipe(Effect.forkChild);
            // The slot is claimed and the first record is in flight: no run to interrupt yet.
            yield* Deferred.await(writing);

            const cancelling = yield* service
              .cancel(threadId)
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.succeed(finishWrite, undefined);

            const { attemptId } = yield* Fiber.join(starting);
            expect(yield* Fiber.join(cancelling)).toBe(true);

            const last = attemptsFrom(harness.dispatched).at(-1);
            expect(last).toMatchObject({ attemptId, phase: "cancelled", runDir: null });
            expect(last?.checks.some((check) => check.status === "running")).toBe(false);
            // The slot is free again, so there is nothing left to cancel.
            expect(yield* service.cancel(threadId)).toBe(false);
          }).pipe(Effect.provide(harness.layer), asMac);
        }),
    );

    it.effect("an unconfirmed launch ends the attempt in an error and keeps the folder", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeReleaseWorkspace();
        // The launcher's reply cannot be read, so it is unknown whether the app ever started.
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION, launcher: "unusable" });
        const harness = makeHarness({ workspaceRoot: workspace.root, tools });

        const final = yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const { attemptId } = yield* service.run(threadId);
          const ended = yield* Deferred.await(harness.settled(attemptId));
          const writes = harness.dispatched.length;

          const result = yield* service.get(threadId);
          const derived = deriveReleaseVerificationState(result);
          expect(derived.state).toBe("needs-confirmation");
          expect(
            derived.reasons.some((reason) => reason.startsWith("Verification could not")),
          ).toBe(true);

          // A later start cannot touch it either: the record shows a launch began.
          yield* service.reconcile;
          expect(harness.dispatched).toHaveLength(writes);
          // The slot is free: the attempt is over.
          expect(yield* service.cancel(threadId)).toBe(false);
          return ended;
        }).pipe(Effect.provide(harness.layer), asMac);

        const runDir = final.runDir ?? "";
        if (runDir !== "") {
          yield* Effect.addFinalizer(() =>
            fileSystem.remove(runDir, { recursive: true, force: true }).pipe(Effect.ignore),
          );
        }
        expect(final.phase).toBe("errored");
        expect(final.error).toContain(LAUNCH_MAY_RUN_NOTE);
        expect(runDir).not.toBe("");
        expect(final.checks.find((check) => check.id === "launch-smoke")?.status).toBe("timed-out");
        expect(final.checks).toHaveLength(RELEASE_VERIFICATION_REQUIRED_CHECKS.length);
        expect(yield* fileSystem.exists(`${runDir}/${LAUNCH_UNCONFIRMED_MARKER}`)).toBe(true);
        expect(yield* fileSystem.exists(`${runDir}/launch/OoP.app`)).toBe(true);
      }),
    );

    it.effect("a delete that fails ends the attempt in an error and keeps the folder", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeReleaseWorkspace();
        // A failing exit, and an exit 0 that left the folder behind.
        for (const failure of [{ rmExit: 1 }, { rmKeepsFolder: true }] as const) {
          const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION, ...failure });
          const harness = makeHarness({ workspaceRoot: workspace.root, tools });

          const final = yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const { attemptId } = yield* service.run(threadId);
            return yield* Deferred.await(harness.settled(attemptId));
          }).pipe(Effect.provide(harness.layer), asMac);

          const runDir = final.runDir ?? "";
          const label = encodeJson(failure);
          if (runDir !== "") {
            yield* Effect.addFinalizer(() =>
              fileSystem.remove(runDir, { recursive: true, force: true }).pipe(Effect.ignore),
            );
          }
          expect(runDir, label).not.toBe("");
          expect(final.phase, label).toBe("errored");
          expect(final.error, label).toBe("The temporary folder could not be deleted.");
          // The checks keep their own results; only the cleanup is what went wrong.
          expect(
            final.checks.map((check) => check.status),
            label,
          ).toEqual(["passed", "passed", "passed", "passed", "passed", "not-run"]);
          expect(tools.calls.at(-1), label).toEqual({
            name: "rm",
            args: ["-rfx", "--", runDir],
          });
          expect(yield* fileSystem.exists(runDir), label).toBe(true);
        }
      }),
    );

    it.effect("an unsupported host reports itself unavailable and changes nothing", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const harness = makeHarness({ workspaceRoot: workspace.root, tools });

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const error = yield* service.run(threadId).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ReleaseVerificationUnavailableError);

          const result = yield* service.get(threadId);
          expect(result.capability.available).toBe(false);
          expect(result.attempt).toBeNull();
          expect(deriveReleaseVerificationState(result).state).toBe("unavailable");
        }).pipe(Effect.provide(harness.layer), asHost("linux"));

        // Each tool the checks rely on counts by itself, the launcher's `env` and the delete's
        // `rm` included.
        for (const missing of ["/usr/bin/hdiutil", "/usr/bin/env", "/bin/rm"]) {
          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            const error = yield* service.run(threadId).pipe(Effect.flip);
            expect(error).toBeInstanceOf(ReleaseVerificationUnavailableError);
            expect(error.message, missing).toContain(missing);
          }).pipe(
            Effect.provide(harness.layer),
            asHost("darwin", (tool) => tool !== missing),
          );
        }

        expect(harness.dispatched).toEqual([]);
        expect(tools.calls).toEqual([]);
      }),
    );

    it.effect(
      "refuses unknown threads and missing builds without recording or holding the slot",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspace = yield* makeReleaseWorkspace();
          const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
          const unknownThread = makeHarness({
            workspaceRoot: workspace.root,
            tools,
            threadExists: false,
          });
          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            expect(yield* service.run(threadId).pipe(Effect.flip)).toBeInstanceOf(
              ReleaseVerificationThreadNotFoundError,
            );
            expect(yield* service.get(threadId).pipe(Effect.flip)).toBeInstanceOf(
              ReleaseVerificationThreadNotFoundError,
            );
          }).pipe(Effect.provide(unknownThread.layer), asMac);
          expect(unknownThread.dispatched).toEqual([]);

          const missingBuild = makeHarness({ workspaceRoot: workspace.root, tools });
          yield* fileSystem.rename(workspace.dmgPath, `${workspace.dmgPath}.moved`);
          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            expect(yield* service.run(threadId).pipe(Effect.flip)).toBeInstanceOf(
              ReleaseVerificationArtifactNotFoundError,
            );
            expect(missingBuild.dispatched).toEqual([]);

            // The refusal left the slot free: with the build back, a run starts.
            yield* fileSystem.rename(`${workspace.dmgPath}.moved`, workspace.dmgPath);
            const { attemptId } = yield* service.run(threadId);
            yield* Deferred.await(missingBuild.settled(attemptId));
          }).pipe(Effect.provide(missingBuild.layer), asMac);
        }),
    );
  });

  describe("get", () => {
    it.effect("shows a persisted running record nobody is running as interrupted", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const harness = makeHarness({
          workspaceRoot: workspace.root,
          tools,
          seed: [rowFor(attemptSeed())],
        });

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const result = yield* service.get(threadId);

          expect(result.attempt?.phase).toBe("interrupted");
          expect(result.attempt?.checks.map((check) => check.status)).toEqual([
            "passed",
            "interrupted",
            "not-run",
            "not-run",
            "not-run",
            "not-run",
          ]);
          expect(result.artifactUnchanged).toBeNull();
          expect(deriveReleaseVerificationState(result).state).toBe("needs-confirmation");
          // Reading changes nothing.
          expect(harness.dispatched).toEqual([]);
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect("ignores a record that is not the thread's own fixed activity", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const own = rowFor(attemptSeed({ phase: "completed" }));
        const otherId = { ...own, activityId: EventId.make("release-verification:someone-else") };
        // The right id, but a payload that claims another thread.
        const otherThread = {
          ...own,
          payload: structuredClone(
            attemptSeed({ phase: "completed", threadId: ThreadId.make("thread-9") }),
          ),
        };

        for (const row of [otherId, otherThread]) {
          const harness = makeHarness({ workspaceRoot: workspace.root, tools, seed: [row] });
          yield* Effect.gen(function* () {
            const service = yield* ReleaseVerification.ReleaseVerification;
            expect((yield* service.get(threadId)).attempt).toBeNull();
          }).pipe(Effect.provide(harness.layer), asMac);
        }
      }),
    );

    it.effect("returns the stored row's server sequence, and omits it with no record", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const harness = makeHarness({ workspaceRoot: workspace.root, tools });

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const empty = yield* service.get(threadId);
          expect(empty.attempt).toBeNull();
          expect(empty).not.toHaveProperty("sequence");
          expect(empty).not.toHaveProperty("environmentMatches");

          const { attemptId } = yield* service.run(threadId);
          yield* Deferred.await(harness.settled(attemptId));

          // The projection stamps every write with its server sequence; the last write is newest.
          const result = yield* service.get(threadId);
          expect(result.attempt?.attemptId).toBe(attemptId);
          expect(result.sequence).toBe(harness.dispatched.length);
          expect(result.environmentMatches).toBe(true);
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect("orders attempts by the row's server sequence, whatever their timestamps say", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const first = attemptSeed({
          attemptId: "attempt-a",
          phase: "interrupted",
          startedAt: "2026-08-20T12:00:00.000Z",
          endedAt: "2026-08-20T12:00:00.000Z",
        });
        const harness = makeHarness({
          workspaceRoot: workspace.root,
          tools,
          seed: [rowFor(first, 5)],
        });
        const activityId = EventId.make(releaseVerificationActivityId(threadId));

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const before = yield* service.get(threadId);
          expect(before.attempt?.attemptId).toBe("attempt-a");
          expect(before.sequence).toBe(5);

          // Newer writes (higher sequence) whose clock ran backwards, then tied with each other.
          for (const [attemptId, at, sequence] of [
            ["attempt-b", "2026-08-20T11:00:00.000Z", 9],
            ["attempt-c", "2026-08-20T11:00:00.000Z", 12],
          ] as const) {
            const attempt = attemptSeed({
              attemptId,
              phase: "cancelled",
              startedAt: at,
              endedAt: at,
            });
            harness.rows.set(activityId, rowFor(attempt, sequence));

            const result = yield* service.get(threadId);
            expect(result.attempt?.attemptId).toBe(attemptId);
            expect(result.sequence).toBe(sequence);
          }
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect("does not carry an old hash onto a newer record that landed meanwhile", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const gate = { armed: false, reads: 0 };
        const parked = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const harness = makeHarness({
          workspaceRoot: workspace.root,
          tools,
          // `get` reads, hashes the file, then reads again: park it before that second read.
          onRead: Effect.suspend(() => {
            if (!gate.armed) return Effect.void;
            gate.reads += 1;
            return gate.reads === 2
              ? Deferred.succeed(parked, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void;
          }),
        });
        const activityId = EventId.make(releaseVerificationActivityId(threadId));

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const { attemptId } = yield* service.run(threadId);
          yield* Deferred.await(harness.settled(attemptId));
          const measured = yield* service.get(threadId);
          expect(measured.artifactUnchanged).toBe(true);

          gate.armed = true;
          const reading = yield* service.get(threadId).pipe(Effect.forkChild);
          yield* Deferred.await(parked);

          // While the file was hashed, a newer attempt that passed every check landed for the
          // same file. Carrying the old hash over would make this record read as verified.
          const newer = attemptSeed({
            attemptId: "attempt-newer",
            revision: 0,
            phase: "completed",
            artifact: measured.attempt?.artifact ?? null,
            checks: passedChecks(),
            endedAt: startedAt,
          });
          harness.rows.set(activityId, rowFor(newer, 99));
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(reading);

          expect(result.attempt?.attemptId).toBe("attempt-newer");
          expect(result.sequence).toBe(99);
          expect(result.artifactUnchanged).toBeNull();
          const derived = deriveReleaseVerificationState(result);
          expect(derived.state).toBe("needs-confirmation");
          expect(derived.reasons).toEqual(["The build file has not been re-checked"]);
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect("verifies an all-passed record only if the server affirms the environment", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const harness = makeHarness({ workspaceRoot: workspace.root, tools });
        const activityId = EventId.make(releaseVerificationActivityId(threadId));

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const { attemptId } = yield* service.run(threadId);
          yield* Deferred.await(harness.settled(attemptId));
          const measured = yield* service.get(threadId);
          // The real run records the unrun startup check, so seed a record that passed it.
          const passed = attemptSeed({
            attemptId: "attempt-passed",
            phase: "completed",
            artifact: measured.attempt?.artifact ?? null,
            checks: passedChecks(),
            endedAt: startedAt,
          });
          harness.rows.set(activityId, rowFor(passed, 50));

          const result = yield* service.get(threadId);
          expect(result.environmentMatches).toBe(true);
          expect(result.artifactUnchanged).toBe(true);
          expect(deriveReleaseVerificationState(result)).toEqual({
            state: "verified",
            reasons: [],
          });

          // The same result without the server's environment answer cannot verify.
          const unreported = deriveReleaseVerificationState({
            capability: result.capability,
            attempt: result.attempt,
            artifactUnchanged: result.artifactUnchanged,
          });
          expect(unreported.state).toBe("needs-confirmation");
          expect(unreported.reasons).toEqual([
            "The server did not say whether this verification was made in its environment",
          ]);
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect("reports no hash while a newer attempt holds the slot but is not stored", () =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const readGate = { armed: false, reads: 0 };
        const writeGate = { on: false };
        const parked = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const writing = yield* Deferred.make<void>();
        const finishWrite = yield* Deferred.make<void>();
        const harness = makeHarness({
          workspaceRoot: workspace.root,
          tools,
          onRead: Effect.suspend(() => {
            if (!readGate.armed) return Effect.void;
            readGate.reads += 1;
            return readGate.reads === 2
              ? Deferred.succeed(parked, undefined).pipe(Effect.andThen(Deferred.await(resume)))
              : Effect.void;
          }),
          onDispatch: () =>
            Effect.suspend(() =>
              writeGate.on
                ? Deferred.succeed(writing, undefined).pipe(
                    Effect.andThen(Deferred.await(finishWrite)),
                  )
                : Effect.void,
            ),
        });

        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          const first = yield* service.run(threadId);
          yield* Deferred.await(harness.settled(first.attemptId));

          readGate.armed = true;
          const reading = yield* service.get(threadId).pipe(Effect.forkChild);
          yield* Deferred.await(parked);

          // While the file was hashed, a new run claimed the slot. Its first record is still in
          // flight, so the store still holds the old one, which the hash did match.
          writeGate.on = true;
          const starting = yield* service.run(threadId).pipe(Effect.forkChild);
          yield* Deferred.await(writing);
          yield* Deferred.succeed(resume, undefined);
          const result = yield* Fiber.join(reading);

          expect(result.attempt?.attemptId).toBe(first.attemptId);
          expect(result.artifactUnchanged).toBeNull();

          yield* Deferred.succeed(finishWrite, undefined);
          const second = yield* Fiber.join(starting);
          yield* Deferred.await(harness.settled(second.attemptId));
        }).pipe(Effect.provide(harness.layer), asMac);
      }),
    );

    it.effect("keeps another environment's record visible but never measures or confirms it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        // The file is gone: a measurement says `false`, so `null` proves none was taken.
        yield* fileSystem.remove(workspace.dmgPath);
        const artifact = {
          workspaceRoot: workspace.root,
          relativePath: `release/macos/OoP-${RELEASE_TEST_VERSION}-arm64.dmg`,
          fileName: `OoP-${RELEASE_TEST_VERSION}-arm64.dmg`,
          appVersion: RELEASE_TEST_VERSION,
          sha256: "a".repeat(64),
          size: 1,
          ino: 1,
          mtimeMs: 1,
        };
        const readFrom = (environment: ReleaseVerificationAttempt["environment"]) => {
          const harness = makeHarness({
            workspaceRoot: workspace.root,
            tools,
            seed: [
              rowFor(
                attemptSeed({ phase: "completed", artifact, checks: passedChecks(), environment }),
                7,
              ),
            ],
          });
          return Effect.flatMap(ReleaseVerification.ReleaseVerification, (service) =>
            service.get(threadId),
          ).pipe(Effect.provide(harness.layer), asMac);
        };

        // Control: this environment's record is measured against the file, which is gone.
        const here = yield* readFrom({ ...hereEnvironment });
        expect(here.environmentMatches).toBe(true);
        expect(here.artifactUnchanged).toBe(false);

        const differences: ReadonlyArray<Partial<ReleaseVerificationAttempt["environment"]>> = [
          { environmentId: EnvironmentId.make("environment-other") },
          { platform: "linux" },
          { arch: "x64" },
          { osRelease: "0.0.0-other" },
          { serverVersion: "0.0.1" },
        ];
        for (const different of differences) {
          const result = yield* readFrom({ ...hereEnvironment, ...different });

          expect(result.attempt?.attemptId).toBe("attempt-seed");
          expect(result.sequence).toBe(7);
          expect(result.environmentMatches).toBe(false);
          expect(result.artifactUnchanged).toBeNull();
          const derived = deriveReleaseVerificationState(result);
          expect(derived.state).toBe("needs-confirmation");
          expect(derived.reasons).toEqual([
            "Verification ran in a different server environment, so it does not confirm this one",
          ]);
        }
      }),
    );
  });

  describe("reconcile", () => {
    const makeOwnedRunDir = (attemptId: string, marker: string | null) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // `asMac` runs the service as a Mac, which keeps its folders under `/tmp`.
        const tempRoot = yield* fileSystem.realPath(runTempDir("darwin"));
        const runDir = path.join(tempRoot, `t3v-${attemptId}`);
        yield* fileSystem.makeDirectory(path.join(runDir, "mnt"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(runDir, "artifact.dmg"), "copy");
        if (marker !== null) {
          yield* fileSystem.writeFileString(path.join(runDir, ".t3-release-verify"), marker);
        }
        yield* Effect.addFinalizer(() =>
          fileSystem.remove(runDir, { recursive: true, force: true }).pipe(Effect.ignore),
        );
        return runDir;
      });

    const reconcileWith = (seed: ReadonlyArray<ReleaseVerificationAttempt>) =>
      Effect.gen(function* () {
        const workspace = yield* makeReleaseWorkspace();
        const tools = makeFakeMacTools({ version: RELEASE_TEST_VERSION });
        const harness = makeHarness({
          workspaceRoot: workspace.root,
          tools,
          seed: seed.map(rowFor),
        });
        yield* Effect.gen(function* () {
          const service = yield* ReleaseVerification.ReleaseVerification;
          yield* service.reconcile;
        }).pipe(Effect.provide(harness.layer), asMac);
        return { records: attemptsFrom(harness.dispatched), tools };
      });

    it.effect("settles a run a previous process left going and removes the folder it owned", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const attemptId = `reconcile-${NodeCrypto.randomUUID()}`;
        const runDir = yield* makeOwnedRunDir(attemptId, attemptId);

        const { records } = yield* reconcileWith([attemptSeed({ attemptId, runDir })]);

        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({
          attemptId,
          phase: "interrupted",
          runDir: null,
          revision: 3,
        });
        expect(records[0]?.endedAt).not.toBeNull();
        expect(records[0]?.error).toContain("restarted");
        expect(records[0]?.checks.map((check) => check.status)).toEqual([
          "passed",
          "interrupted",
          "not-run",
          "not-run",
          "not-run",
          "not-run",
        ]);
        expect(yield* fileSystem.exists(runDir)).toBe(false);
      }),
    );

    it.effect("settles the record but leaves a folder without a matching marker alone", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const mismatched = yield* makeOwnedRunDir(
          `reconcile-${NodeCrypto.randomUUID()}`,
          "someone-else",
        );
        const missing = yield* makeOwnedRunDir(`reconcile-${NodeCrypto.randomUUID()}`, null);

        for (const runDir of [mismatched, missing]) {
          const attemptId = runDir.slice(runDir.indexOf("t3v-") + "t3v-".length);
          const { records } = yield* reconcileWith([attemptSeed({ attemptId, runDir })]);

          expect(records).toHaveLength(1);
          expect(records[0]).toMatchObject({ phase: "interrupted", runDir });
          expect(records[0]?.error).toContain("ownership marker");
          expect(yield* fileSystem.exists(runDir)).toBe(true);
        }
      }),
    );

    it.effect("never touches a folder outside its own naming and location", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const unrelated = yield* fileSystem.makeTempDirectoryScoped({ prefix: "keep-me-" });
        yield* fileSystem.writeFileString(
          path.join(unrelated, ".t3-release-verify"),
          "attempt-seed",
        );

        const { records } = yield* reconcileWith([attemptSeed({ runDir: unrelated })]);

        expect(records[0]).toMatchObject({ phase: "interrupted", runDir: unrelated });
        expect(records[0]?.error).toContain("not one this server created");
        expect(yield* fileSystem.exists(path.join(unrelated, ".t3-release-verify"))).toBe(true);
      }),
    );

    it.effect(
      "leaves settled records alone, and retries cleanup for one that kept its folder",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const attemptId = `reconcile-${NodeCrypto.randomUUID()}`;
          const runDir = yield* makeOwnedRunDir(attemptId, attemptId);

          const settledOnly = yield* reconcileWith([
            attemptSeed({ phase: "completed", endedAt: startedAt }),
            attemptSeed({ threadId: ThreadId.make("thread-2"), phase: "cancelled" }),
          ]);
          expect(settledOnly.records).toEqual([]);

          const retried = yield* reconcileWith([
            attemptSeed({
              attemptId,
              runDir,
              phase: "errored",
              endedAt: startedAt,
              error: "The disk image could not be unmounted.",
            }),
          ]);
          expect(retried.records).toHaveLength(1);
          expect(retried.records[0]).toMatchObject({
            phase: "errored",
            runDir: null,
            error: "The disk image could not be unmounted.",
          });
          expect(yield* fileSystem.exists(runDir)).toBe(false);
        }),
    );

    // `began` is whether the launch step ever started: its start time is what a record can show.
    const withLaunch = (status: ReleaseVerificationCheck["status"], began: boolean) =>
      passedChecks().map((check) =>
        check.id === "launch-smoke"
          ? { ...check, status, startedAt: began ? startedAt : null }
          : check,
      );

    it.effect("keeps the folder as evidence when a launched app may still own it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const attemptId = `reconcile-${NodeCrypto.randomUUID()}`;
        const runDir = yield* makeOwnedRunDir(attemptId, attemptId);

        const { records } = yield* reconcileWith([
          attemptSeed({ attemptId, runDir, checks: withLaunch("running", true) }),
        ]);

        // Settled as interrupted, and nothing else: no force detach, no delete, no rerun.
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ attemptId, phase: "interrupted", runDir, revision: 3 });
        expect(records[0]?.error).toContain("restarted");
        expect(records[0]?.error).toContain("manual recovery");
        expect(records[0]?.checks.find((check) => check.id === "launch-smoke")?.status).toBe(
          "interrupted",
        );
        expect(yield* fileSystem.exists(`${runDir}/artifact.dmg`)).toBe(true);
        expect(yield* fileSystem.exists(`${runDir}/.t3-release-verify`)).toBe(true);
      }),
    );

    it.effect("refuses a folder with the launch marker even when the record shows no launch", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const attemptId = `reconcile-${NodeCrypto.randomUUID()}`;
        const runDir = yield* makeOwnedRunDir(attemptId, attemptId);
        // An unknown launcher can leave the check looking never-launched: the marker still speaks.
        yield* fileSystem.writeFileString(`${runDir}/${LAUNCH_UNCONFIRMED_MARKER}`, "x");

        const running = yield* reconcileWith([attemptSeed({ attemptId, runDir })]);
        expect(running.records).toHaveLength(1);
        expect(running.records[0]).toMatchObject({ attemptId, phase: "interrupted", runDir });
        expect(running.records[0]?.error).toContain("manual recovery");

        // A settled record that kept its folder is left alone, not retried.
        const settled = yield* reconcileWith([
          attemptSeed({ attemptId, runDir, phase: "errored", endedAt: startedAt, error: "x" }),
        ]);
        expect(settled.records).toEqual([]);
        expect(yield* fileSystem.exists(`${runDir}/artifact.dmg`)).toBe(true);
        expect(yield* fileSystem.exists(`${runDir}/${LAUNCH_UNCONFIRMED_MARKER}`)).toBe(true);
      }),
    );

    it.effect("leaves a settled record alone when its launch may have left an app", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const attemptId = `reconcile-${NodeCrypto.randomUUID()}`;
        const runDir = yield* makeOwnedRunDir(attemptId, attemptId);

        const { records, tools } = yield* reconcileWith([
          attemptSeed({
            attemptId,
            runDir,
            phase: "errored",
            endedAt: startedAt,
            error: "The disk image could not be unmounted.",
            checks: withLaunch("passed", true),
          }),
        ]);

        expect(records).toEqual([]);
        expect(tools.calls).toEqual([]);
        expect(yield* fileSystem.exists(runDir)).toBe(true);
      }),
    );

    it.effect("only a record whose launch step never began is cleaned up", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        // [status, began, preserved]. The helper also reports "not-run" after a real start, so
        // the status cannot say; the step's start time can.
        const cases = [
          ["running", true, true],
          ["passed", true, true],
          ["failed", true, true],
          ["timed-out", true, true],
          ["interrupted", true, true],
          ["not-run", true, true],
          ["pending", false, false],
          ["not-run", false, false],
          ["skipped", false, false],
        ] as const;

        for (const [status, began, preserved] of cases) {
          const attemptId = `reconcile-${NodeCrypto.randomUUID()}`;
          const runDir = yield* makeOwnedRunDir(attemptId, attemptId);

          const { records } = yield* reconcileWith([
            attemptSeed({ attemptId, runDir, checks: withLaunch(status, began) }),
          ]);

          const label = `${status}, began ${began}`;
          expect(records, label).toHaveLength(1);
          expect(records[0]?.runDir, label).toBe(preserved ? runDir : null);
          expect(yield* fileSystem.exists(runDir), label).toBe(preserved);
        }

        // A record that does not show the launch check exactly once cannot show there was none.
        const bareId = `reconcile-${NodeCrypto.randomUUID()}`;
        const bareDir = yield* makeOwnedRunDir(bareId, bareId);
        const bare = yield* reconcileWith([
          attemptSeed({
            attemptId: bareId,
            runDir: bareDir,
            checks: passedChecks().filter((check) => check.id !== "launch-smoke"),
          }),
        ]);
        expect(bare.records[0]?.runDir).toBe(bareDir);
        expect(yield* fileSystem.exists(bareDir)).toBe(true);
      }),
    );
  });
});
