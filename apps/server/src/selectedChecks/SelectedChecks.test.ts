// @effect-diagnostics nodeBuiltinImport:off - Lifecycle cases run on seams with
// Deferred gates and no processes; the two real-executor cases are finite and
// POSIX-only: one `true` in a temp Git repo, one failed spawn with no child.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  type OrchestrationCommand,
  type ProjectScript,
  ProjectId,
  SELECTED_CHECK_RECEIPT_KIND,
  SelectedCheckReceipt,
  SelectedChecksRejectedError,
  SelectedChecksThreadNotFoundError,
  ThreadId,
  type VcsError,
  deriveSelectedCheckState,
  selectedCheckReceiptId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  type ProjectionThreadActivity,
  ProjectionThreadActivityRepository,
} from "../persistence/Services/ProjectionThreadActivities.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as OwnerMarker from "./ownerMarker.ts";
import * as ScriptExecutor from "./ScriptExecutor.ts";
import * as SelectedChecks from "./SelectedChecks.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const threadId: ThreadId = ThreadId.make("thread-1");
const startedAt = "2026-08-20T12:00:00.000Z";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const TREE_OID = "0".repeat(40);

const decodeReceiptSync = Schema.decodeUnknownSync(SelectedCheckReceipt);

const sha256Text = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const script = (id: string, command: string): ProjectScript => ({
  id,
  name: id,
  command,
  icon: "play",
  runOnWorktreeCreate: false,
});

const passedResult = (pgid: number): ScriptExecutor.ScriptExecutionResult => ({
  status: "passed",
  exitCode: 0,
  exitedBy: "exit",
  exitSignal: null,
  pgid,
  group: "empty",
  stdout: { bytes: 0, sha256: EMPTY_SHA256 },
  stderr: { bytes: 0, sha256: EMPTY_SHA256 },
  failure: null,
});

const unknownResult = (pgid: number): ScriptExecutor.ScriptExecutionResult => ({
  status: "unproven",
  exitCode: 0,
  exitedBy: "exit",
  exitSignal: null,
  pgid,
  group: "unknown",
  stdout: { bytes: 0, sha256: EMPTY_SHA256 },
  stderr: { bytes: 0, sha256: EMPTY_SHA256 },
  failure: "cleanup-denied",
});

/** The executor's own pre-spawn answer to a latched cancel: no run, no evidence. */
const cancelledNotStarted = (): ScriptExecutor.ScriptExecutionResult => ({
  status: "cancelled",
  exitCode: null,
  exitedBy: "cancel",
  exitSignal: null,
  pgid: null,
  group: "not-started",
  stdout: null,
  stderr: null,
  failure: null,
});

/**
 * A seam with the executor's contract: a cancel latched before the seam runs is
 * a cancelled not-started result, so lifecycle tests prove the service checks
 * the latch, not that the seam happened to be polite.
 */
const seamRunScript =
  (
    behavior: (
      input: ScriptExecutor.ScriptExecutionInput,
    ) => Effect.Effect<ScriptExecutor.ScriptExecutionResult>,
    calls: Array<string>,
  ): typeof ScriptExecutor.runScript =>
  (input) =>
    Effect.gen(function* () {
      if (input.cancelSignal !== undefined && (yield* Deferred.isDone(input.cancelSignal))) {
        return cancelledNotStarted();
      }
      calls.push(input.command);
      return yield* behavior(input);
    });

const defaultTree = (cwd: string): VcsDriver.VcsTreeObservation => ({
  kind: "complete",
  treeOid: TREE_OID,
  topLevel: cwd,
  commonDir: NodePath.join(cwd, ".git"),
});

const ownedMarkerText = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    state: "owned",
    attemptId: "attempt-seed",
    threadId,
    scriptId: null,
    pgid: null,
    writtenAt: startedAt,
    ...overrides,
  });

const releasedMarkerText = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    version: 1,
    state: "released",
    how: "acknowledged",
    previousSha256: "a".repeat(64),
    previous: null,
    releasedAt: startedAt,
    ...overrides,
  });

interface HarnessControls {
  threadExists: boolean;
  turnRunning: boolean;
  threadCreatedAt: string;
  recreated: boolean;
  scripts: Array<ProjectScript>;
  workspaceRoot: string;
  worktreePath: string | null;
  observeTree: (cwd: string) => Effect.Effect<VcsDriver.VcsTreeObservation, VcsError>;
}

interface Harness {
  readonly layer: Layer.Layer<SelectedChecks.SelectedChecks>;
  readonly dispatched: Array<OrchestrationCommand>;
  readonly rows: Map<string, ProjectionThreadActivity>;
  /**
   * Completed by the dispatch of the attempt's terminal (non-running) record —
   * a stored record, not the worker's completion: the finalizer still has to
   * finish its write and free the live slot afterwards.
   */
  readonly terminalRecordWritten: (attemptId: string) => Deferred.Deferred<SelectedCheckReceipt>;
  /** The actual worker fiber, captured on its own effects (executor seam or R2 read). */
  readonly worker: { current: Fiber.Fiber<unknown, unknown> | null };
  readonly controls: HarnessControls;
  readonly stateDir: string;
  readonly markerPath: string;
  /** Armed faults fail exactly one marker-write step of the next transition. */
  readonly faults: {
    rename: boolean;
    dirOpen: boolean;
    readFailOnArmedCall: number | null;
    /** One-shot: the next marker read parks until resumed, then proceeds. */
    parkRead: { parked: Deferred.Deferred<void>; resume: Deferred.Deferred<void> } | null;
    /** Marker reads still armed to die — `1` one-shot, `Infinity` persistent. */
    dieReads: number;
    /** Marker reads that actually died. */
    diedReads: number;
  };
}

/**
 * The service under test with stand-ins for the engine, projection, event
 * store, settings, environment and VCS registry: a dispatched activity upserts
 * one row by id, like the real projection, so what `get` reads is what the last
 * write left. The marker file lives in a fresh temp state dir; a FileSystem
 * proxy arms byte-level faults for the ambiguous write cases.
 */
const makeHarness = (options?: {
  readonly workspaceRoot?: string;
  readonly scripts?: Array<ProjectScript>;
  readonly threadExists?: boolean;
  readonly realGit?: boolean;
  readonly service?: SelectedChecks.SelectedChecksOptions;
  readonly onDispatch?: (writeNumber: number, command: OrchestrationCommand) => Effect.Effect<void>;
  /** Runs at the start of each thread-shell read; a gate here parks the worker in R2. */
  readonly onThreadRead?: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scx-svc-" });
    const markerPath = path.join(stateDir, OwnerMarker.OWNER_MARKER_FILE);

    const dispatched: Array<OrchestrationCommand> = [];
    const rows = new Map<string, ProjectionThreadActivity>();
    const waiters = new Map<string, Deferred.Deferred<SelectedCheckReceipt>>();
    const terminalRecordWritten = (attemptId: string) => {
      const existing = waiters.get(attemptId);
      if (existing !== undefined) return existing;
      const created = Deferred.makeUnsafe<SelectedCheckReceipt>();
      waiters.set(attemptId, created);
      return created;
    };
    const worker: { current: Fiber.Fiber<unknown, unknown> | null } = { current: null };
    let threadReads = 0;

    const controls: HarnessControls = {
      threadExists: options?.threadExists ?? true,
      turnRunning: false,
      threadCreatedAt: startedAt,
      recreated: false,
      scripts: options?.scripts ?? [script("check-a", "echo a"), script("check-b", "echo b")],
      workspaceRoot: options?.workspaceRoot ?? "/workspace",
      worktreePath: null,
      observeTree: (cwd) => Effect.succeed(defaultTree(cwd)),
    };

    const faults = {
      rename: false,
      dirOpen: false,
      readFailOnArmedCall: null as number | null,
      parkRead: null as { parked: Deferred.Deferred<void>; resume: Deferred.Deferred<void> } | null,
      dieReads: 0,
      diedReads: 0,
    };
    let armedReads = 0;
    const injected = { reason: { _tag: "IoError", cause: { code: "EIO" } } };
    const flakyFs = {
      ...fileSystem,
      rename: (...args: Parameters<FileSystem.FileSystem["rename"]>) =>
        faults.rename
          ? ((faults.rename = false), Effect.fail(injected as never))
          : fileSystem.rename(...args),
      open: (...args: Parameters<FileSystem.FileSystem["open"]>) =>
        faults.dirOpen && args[1]?.flag === "r"
          ? ((faults.dirOpen = false), Effect.fail(injected as never))
          : fileSystem.open(...args),
      readFile: (...args: Parameters<FileSystem.FileSystem["readFile"]>) => {
        if (faults.dieReads > 0) {
          faults.dieReads -= 1;
          faults.diedReads += 1;
          return Effect.die(injected);
        }
        if (faults.parkRead !== null) {
          const gate = faults.parkRead;
          faults.parkRead = null;
          return Deferred.succeed(gate.parked, undefined).pipe(
            Effect.andThen(Deferred.await(gate.resume)),
            Effect.andThen(fileSystem.readFile(...args)),
          );
        }
        if (faults.readFailOnArmedCall !== null) {
          armedReads += 1;
          if (armedReads >= faults.readFailOnArmedCall) {
            faults.readFailOnArmedCall = null;
            return Effect.fail(injected as never);
          }
        }
        return fileSystem.readFile(...args);
      },
    } as unknown as FileSystem.FileSystem;

    const registryLayer = options?.realGit
      ? Layer.effect(
          VcsDriverRegistry.VcsDriverRegistry,
          Effect.map(
            GitVcsDriver.makeVcsDriver,
            (driver): VcsDriverRegistry.VcsDriverRegistry["Service"] =>
              ({
                get: () => Effect.succeed(driver),
                detect: () =>
                  Effect.succeed({ kind: "git" as const, repository: {} as never, driver }),
                resolve: () =>
                  Effect.succeed({ kind: "git" as const, repository: {} as never, driver }),
              }) as never,
          ),
        ).pipe(Layer.provide(VcsProcess.layer), Layer.provide(ProcessRunner.layer))
      : Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () =>
            Effect.succeed({
              kind: "git" as const,
              repository: {} as never,
              driver: {
                checkpoints: {
                  observeTree: (input: { readonly cwd: string }) => controls.observeTree(input.cwd),
                },
              },
            } as never),
        });

    // A failing test must not hang the harness scope close behind the
    // cooperative shutdown wait: with zero grace the service's shutdown
    // finalizer interrupts a parked worker immediately instead of waiting on an
    // unadvanced clock. Tests that exercise the grace pass their own value.
    // Whatever executor a test chose — or the frozen real one — is wrapped so
    // the actual worker fiber is captured at the spawn boundary.
    const innerRunScript = options?.service?.runScript ?? ScriptExecutor.runScript;
    const serviceOptions: SelectedChecks.SelectedChecksOptions = {
      ...options?.service,
      runScript: (input) =>
        Effect.withFiber((fiber) => {
          worker.current = fiber;
          return innerRunScript(input);
        }),
      shutdownGrace: options?.service?.shutdownGrace ?? Duration.zero,
    };
    const layer = Layer.effect(
      SelectedChecks.SelectedChecks,
      SelectedChecks.make(serviceOptions),
    ).pipe(
      Layer.provide(Layer.succeed(FileSystem.FileSystem, flakyFs)),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            dispatch: (command) =>
              Effect.gen(function* () {
                yield* options?.onDispatch?.(dispatched.length + 1, command) ?? Effect.void;
                dispatched.push(command);
                const sequence = dispatched.length;
                if (command.type === "thread.activity.append") {
                  const receipt = decodeReceiptSync(command.activity.payload);
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
                  if (receipt.phase !== "running") {
                    yield* Deferred.succeed(terminalRecordWritten(receipt.attemptId), receipt);
                  }
                }
                return { sequence };
              }),
          }),
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getThreadShellById: (id) =>
              Effect.gen(function* () {
                yield* options?.onThreadRead ?? Effect.void;
                // The second read is R2, executed on the worker fiber — the
                // capture point for pre-executor completion boundaries. Later
                // reads run on the test caller; capturing those would make
                // workerExit await the caller itself.
                threadReads += 1;
                if (threadReads === 2) {
                  yield* Effect.withFiber((fiber) =>
                    Effect.sync(() => {
                      worker.current = fiber;
                    }),
                  );
                }
                if (!controls.threadExists) return Option.none();
                return Option.some({
                  id,
                  projectId: ProjectId.make("project-1"),
                  worktreePath: controls.worktreePath,
                  createdAt: controls.threadCreatedAt,
                  latestTurn: controls.turnRunning
                    ? {
                        turnId: "turn-1",
                        state: "running",
                        requestedAt: startedAt,
                        startedAt,
                        completedAt: null,
                        assistantMessageId: null,
                      }
                    : null,
                } as never);
              }),
            getProjectShellById: () =>
              Effect.succeedSome({
                id: ProjectId.make("project-1"),
                workspaceRoot: controls.workspaceRoot,
                scripts: [...controls.scripts],
              } as never),
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
              Effect.succeed(
                [...rows.values()].filter(
                  (row) =>
                    row.threadId === input.threadId &&
                    (input.activityKinds === undefined || input.activityKinds.includes(row.kind)),
                ),
              ),
          }),
          Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
            hasEventAfter: () => Effect.succeed(controls.recreated),
          }),
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            // Read at execution time, so a test can change the registered
            // scripts after the harness snapshot was taken.
            getSettings: Effect.sync(() => ({
              ...DEFAULT_SERVER_SETTINGS,
              defaultProjectScripts: [...controls.scripts],
              projectSettingsFolded: true,
            })),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getDescriptor: Effect.succeed({
              environmentId: EnvironmentId.make("environment-1"),
              serverVersion: "0.0.45",
            } as never),
          }),
          registryLayer,
          Layer.succeed(ServerConfig.ServerConfig, { stateDir } as never),
        ),
      ),
      Layer.provide(NodeServices.layer),
    );

    return {
      layer,
      dispatched,
      rows,
      terminalRecordWritten,
      worker,
      controls,
      stateDir,
      markerPath,
      faults,
    } satisfies Harness;
  });

type Service = SelectedChecks.SelectedChecks["Service"];

/** Resolves the service and runs startup reconciliation, like the server does. */
const withService = <A, E, R>(
  harness: Harness,
  f: (service: Service, harness: Harness) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const service = yield* SelectedChecks.SelectedChecks;
    yield* service.reconcile;
    return yield* f(service, harness);
  }).pipe(Effect.provide(harness.layer));

const storedReceipt = (harness: Harness): SelectedCheckReceipt | null => {
  const row = harness.rows.get(selectedCheckReceiptId(threadId));
  return row === undefined ? null : decodeReceiptSync(row.payload);
};

const readMarkerText = (harness: Harness) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(harness.markerPath).pipe(Effect.option);
    return Option.isSome(text) ? text.value : null;
  });

const admissionState = (service: Service) =>
  Effect.map(service.get(threadId), (result) => result.admission.state);

/** Narrows a flipped run error to the rejection by tag, so its reason is readable. */
const asRejected = (
  error: SelectedChecksRejectedError | SelectedChecksThreadNotFoundError,
): SelectedChecksRejectedError => {
  if (error._tag !== "SelectedChecksRejectedError") {
    throw new Error(`expected a selected-checks rejection, got ${error._tag}`);
  }
  return error;
};

/**
 * A real completion boundary: the captured worker fiber's exit, whose onExit
 * finalizer — record write, owner disposition, slot release — has finished when
 * this returns. Never a final-dispatch callback, poll, or sleep. A missing
 * capture means the boundary was never reached: die loudly instead of proving
 * completion vacuously.
 */
const workerExit = (harness: Harness) => {
  const fiber = harness.worker.current;
  return fiber === null
    ? Effect.die(new Error("workerExit: no worker fiber was captured at the completion boundary"))
    : Fiber.await(fiber);
};

/** Gates write number `n` of the record: signals `writing`, then holds until `finish`. */
const gateWrite = (n: number, after?: (command: OrchestrationCommand) => void) =>
  Effect.gen(function* () {
    const writing = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const armed = { on: true };
    yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
    return {
      writing,
      finish,
      onDispatch: (writeNumber: number, command: OrchestrationCommand) =>
        Effect.suspend(() => {
          if (writeNumber !== n || !armed.on) return Effect.void;
          armed.on = false;
          after?.(command);
          return Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(finish)));
        }),
    };
  });

const runningReceiptSeed = (
  overrides: Partial<SelectedCheckReceipt> = {},
): SelectedCheckReceipt => ({
  schemaVersion: 1,
  threadId,
  attemptId: "attempt-seed",
  revision: 1,
  threadAnchorSequence: null,
  context: {
    projectId: ProjectId.make("project-1"),
    workspaceRoot: "/workspace",
    worktreePath: null,
    cwd: "/workspace",
    shell: process.env.SHELL ?? "/bin/sh",
    envSha256: sha256Text(
      JSON.stringify(Object.entries({ T3CODE_PROJECT_ROOT: "/workspace" }).sort()),
    ),
  },
  planned: [
    {
      scriptId: "check-a",
      scriptName: "check-a",
      commandSha256: sha256Text("echo a"),
      timeoutMs: 600_000,
    },
  ],
  environment: {
    environmentId: EnvironmentId.make("environment-1"),
    platform: "darwin",
    arch: "arm64",
    osRelease: "test",
    serverVersion: "0.0.45",
    nodeVersion: "v22.0.0",
  },
  tree: {
    atStart: { kind: "not-captured" },
    atEnd: { kind: "not-captured" },
    repoAtStart: null,
    repoAtEnd: null,
  },
  phase: "running",
  checks: [
    {
      scriptId: "check-a",
      status: "running",
      startedAt,
      endedAt: null,
      exitCode: null,
      exitedBy: null,
      exitSignal: null,
      pgid: null,
      group: null,
      stdout: null,
      stderr: null,
      failure: null,
    },
  ],
  startedAt,
  endedAt: null,
  error: null,
  ...overrides,
});

const seedRow = (harness: Harness, receipt: SelectedCheckReceipt, sequence = 1) => {
  harness.rows.set(selectedCheckReceiptId(threadId), {
    activityId: EventId.make(selectedCheckReceiptId(threadId)),
    threadId,
    turnId: null,
    tone: "info",
    kind: SELECTED_CHECK_RECEIPT_KIND,
    summary: "Running selected checks",
    payload: structuredClone(receipt),
    sequence,
    createdAt: receipt.startedAt,
  });
};

/** The environment the service would record right now, read the same way it reads it. */
const measuredEnvironment = Effect.gen(function* () {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    platform: yield* HostProcessPlatform,
    arch: yield* HostProcessArchitecture,
    osRelease: NodeOS.release(),
    serverVersion: "0.0.45",
    nodeVersion: process.version,
  } satisfies SelectedCheckReceipt["environment"];
});

/** A finished record whose context, environment, and tree all match the harness defaults. */
const completedReceiptSeed = (
  environment: SelectedCheckReceipt["environment"],
  overrides: Partial<SelectedCheckReceipt> = {},
): SelectedCheckReceipt =>
  runningReceiptSeed({
    revision: 2,
    environment,
    tree: {
      atStart: { kind: "complete", treeOid: TREE_OID },
      atEnd: { kind: "complete", treeOid: TREE_OID },
      repoAtStart: { topLevel: "/workspace", commonDir: NodePath.join("/workspace", ".git") },
      repoAtEnd: { topLevel: "/workspace", commonDir: NodePath.join("/workspace", ".git") },
    },
    phase: "completed",
    endedAt: "2026-08-20T12:01:00.000Z",
    checks: [
      {
        scriptId: "check-a",
        status: "passed",
        startedAt,
        endedAt: "2026-08-20T12:01:00.000Z",
        exitCode: 0,
        exitedBy: "exit",
        exitSignal: null,
        pgid: 4711,
        group: "empty",
        stdout: { bytes: 0, sha256: EMPTY_SHA256 },
        stderr: { bytes: 0, sha256: EMPTY_SHA256 },
        failure: null,
      },
    ],
    ...overrides,
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("SelectedChecks", (it) => {
  describe("run admission", () => {
    it.effect("refuses every run until startup reconciliation happened", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* Effect.gen(function* () {
          const service = yield* SelectedChecks.SelectedChecks;
          const rejected = asRejected(
            yield* service.run({ threadId, scriptIds: ["check-a"] }).pipe(Effect.flip),
          );
          expect(rejected).toBeInstanceOf(SelectedChecksRejectedError);
          expect(rejected.reason).toBe("reconciling");
          expect((yield* service.get(threadId)).admission).toEqual({ state: "reconciling" });
          expect(harness.dispatched).toEqual([]);
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("refuses unknown threads without writing or claiming anything", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ threadExists: false });
        yield* Effect.gen(function* () {
          const service = yield* SelectedChecks.SelectedChecks;
          yield* service.reconcile;
          expect(yield* service.get(threadId).pipe(Effect.flip)).toBeInstanceOf(
            SelectedChecksThreadNotFoundError,
          );
          const rejected = yield* service
            .run({ threadId, scriptIds: ["check-a"] })
            .pipe(Effect.flip);
          expect(rejected).toBeInstanceOf(SelectedChecksThreadNotFoundError);
          expect(harness.dispatched).toEqual([]);
          expect(yield* readMarkerText(harness)).toBeNull();
        }).pipe(Effect.provide(harness.layer));
      }),
    );

    it.effect("refuses a run while the thread's turn is active", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            harness.controls.turnRunning = true;
            const rejected = asRejected(
              yield* service.run({ threadId, scriptIds: ["check-a"] }).pipe(Effect.flip),
            );
            expect(rejected).toBeInstanceOf(SelectedChecksRejectedError);
            expect(rejected.reason).toBe("turn-active");
            expect(harness.dispatched).toEqual([]);
          }),
        );
      }),
    );

    it.effect("names the first requested script that is not registered", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const rejected = asRejected(
              yield* service.run({ threadId, scriptIds: ["check-a", "nope"] }).pipe(Effect.flip),
            );
            expect(rejected).toBeInstanceOf(SelectedChecksRejectedError);
            expect(rejected.reason).toBe("script-not-found");
            expect(rejected.scriptId).toBe("nope");
            expect(harness.dispatched).toEqual([]);
          }),
        );
      }),
    );

    it.effect("refuses a second run while one attempt is live", () =>
      Effect.gen(function* () {
        const scriptStarted = yield* Deferred.make<void>();
        const releaseScript = yield* Deferred.make<void>();
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: {
            runScript: seamRunScript(
              () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(scriptStarted, undefined);
                  yield* Deferred.await(releaseScript);
                  return passedResult(4711);
                }),
              calls,
            ),
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptStarted);
            expect(yield* service.get(threadId)).toMatchObject({
              admission: { state: "busy", threadId, attemptId: started.attemptId },
            });
            const busy = asRejected(
              yield* service.run({ threadId, scriptIds: ["check-b"] }).pipe(Effect.flip),
            );
            expect(busy).toBeInstanceOf(SelectedChecksRejectedError);
            expect(busy.reason).toBe("busy");

            yield* Deferred.succeed(releaseScript, undefined);
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);
            expect(yield* admissionState(service)).toBe("open");
          }),
        );
      }),
    );
  });

  describe("cancellation and linearization", () => {
    it.effect(
      "a cancel accepted while the running write is held stops the attempt with zero spawns",
      () =>
        Effect.gen(function* () {
          const calls: Array<string> = [];
          const gate = yield* gateWrite(2);
          const harness = yield* makeHarness({
            onDispatch: gate.onDispatch,
            service: {
              runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls),
            },
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const starting = yield* service
                .run({ threadId, scriptIds: ["check-a"] })
                .pipe(Effect.forkChild);
              yield* Deferred.await(gate.writing);
              const started = yield* Fiber.join(starting);

              const cancelling = yield* service
                .cancel({ threadId, attemptId: started.attemptId })
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Effect.yieldNow;
              yield* Deferred.succeed(gate.finish, undefined);
              expect(yield* Fiber.join(cancelling)).toEqual({ cancelled: true });
              const ended = yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
              expect(ended.phase).toBe("cancelled");
              expect(calls).toEqual([]);
              expect(yield* service.cancel({ threadId, attemptId: started.attemptId })).toEqual({
                cancelled: false,
              });
            }),
          );
        }),
    );

    it.effect(
      "a cancel accepted just after the last script passed still ends cancelled, never passed",
      () =>
        Effect.gen(function* () {
          const scriptRan = yield* Deferred.make<void>();
          const calls: Array<string> = [];
          const harness = yield* makeHarness({
            service: {
              runScript: seamRunScript(
                () => Deferred.succeed(scriptRan, undefined).pipe(Effect.as(passedResult(4711))),
                calls,
              ),
            },
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
              yield* Deferred.await(scriptRan);

              const cancelling = yield* service
                .cancel({ threadId, attemptId: started.attemptId })
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Effect.yieldNow;
              expect(yield* Fiber.join(cancelling)).toEqual({ cancelled: true });

              const ended = yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
              expect(ended.phase).toBe("cancelled");
              const result = yield* service.get(threadId);
              expect(result.record.kind === "present" && result.record.receipt.phase).toBe(
                "cancelled",
              );
              expect(deriveSelectedCheckState(result.record).state).not.toBe("all-selected-passed");
            }),
          );
        }),
    );

    it.effect("a cancel after the attempt's exit is false and rewrites nothing", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            const ended = yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);
            const writes = harness.dispatched.length;

            expect(yield* service.cancel({ threadId, attemptId: started.attemptId })).toEqual({
              cancelled: false,
            });
            expect(storedReceipt(harness)?.revision).toBe(ended.revision);
            expect(harness.dispatched).toHaveLength(writes);
          }),
        );
      }),
    );

    it.effect("a stale attempt or foreign thread has nothing to cancel", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);

            expect(yield* service.cancel({ threadId, attemptId: "attempt-gone" })).toEqual({
              cancelled: false,
            });
            expect(
              yield* service.cancel({
                threadId: ThreadId.make("thread-2"),
                attemptId: started.attemptId,
              }),
            ).toEqual({ cancelled: false });
          }),
        );
      }),
    );

    it.effect(
      "an accepted cancel wins over a later registration failure and keeps the reason as detail",
      () =>
        Effect.gen(function* () {
          const calls: Array<string> = [];
          let attemptId = "";
          const gate = yield* gateWrite(1, (command) => {
            if (command.type === "thread.activity.append") {
              attemptId = decodeReceiptSync(command.activity.payload).attemptId;
            }
          });
          const harness = yield* makeHarness({
            threadExists: true,
            onDispatch: gate.onDispatch,
            service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const starting = yield* service
                .run({ threadId, scriptIds: ["check-a"] })
                .pipe(Effect.forkChild);
              yield* Deferred.await(gate.writing);
              expect(attemptId).not.toBe("");

              const cancelling = yield* service
                .cancel({ threadId, attemptId })
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Effect.yieldNow;

              // The thread disappears before R2 re-reads it: registration fails.
              harness.controls.threadExists = false;
              yield* Deferred.succeed(gate.finish, undefined);

              const exit = yield* Fiber.await(starting);
              const rejection = Exit.isSuccess(exit) ? null : Cause.squash(exit.cause);
              expect(rejection).toBeInstanceOf(SelectedChecksRejectedError);
              expect((rejection as SelectedChecksRejectedError).reason).toBe("context-changed");
              expect(yield* Fiber.join(cancelling)).toEqual({ cancelled: true });

              const ended = yield* Deferred.await(harness.terminalRecordWritten(attemptId));
              expect(ended).toMatchObject({ phase: "cancelled", error: "context-changed" });
              expect(calls).toEqual([]);
            }),
          );
        }),
    );

    it.effect(
      "an accepted cancel without an executor result stays cancelled and keeps the owner",
      () =>
        Effect.gen(function* () {
          const calls: Array<string> = [];
          const seamParked = yield* Deferred.make<void>();
          const harness = yield* makeHarness({
            service: {
              runScript: seamRunScript(
                (input) =>
                  input.cancelSignal === undefined
                    ? Effect.succeed(passedResult(4711))
                    : // A deterministic stand-in for an executor that stops on the
                      // latch but ends without any result: it defects.
                      Deferred.succeed(seamParked, undefined).pipe(
                        Effect.andThen(Deferred.await(input.cancelSignal)),
                        Effect.andThen(Effect.die("stopped without a result")),
                      ),
                calls,
              ),
            },
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
              yield* Deferred.await(seamParked);

              expect(yield* service.cancel({ threadId, attemptId: started.attemptId })).toEqual({
                cancelled: true,
              });
              yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
              yield* workerExit(harness);

              // Cancel owns the phase; the missing result stays recorded, the
              // unproven check stays unproven, and the unresolved owner stays
              // represented — none of it dropped for a cleaner phase.
              const ended = storedReceipt(harness);
              expect(ended).toMatchObject({
                attemptId: started.attemptId,
                phase: "cancelled",
                error: "result-missing",
              });
              expect(ended?.checks[0]).toMatchObject({ status: "unproven", group: null });
              const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
              expect(marker).toMatchObject({
                state: "owned",
                attemptId: started.attemptId,
                scriptId: "check-a",
              });
              expect(yield* admissionState(service)).toBe("owner-unresolved");
            }),
          );
        }),
    );

    it.effect("a cancel arriving after the finalizer's linearization is false", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const parked = yield* Deferred.make<void>();
            const resume = yield* Deferred.make<void>();
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            // The one-shot read park trips inside the finalizer's first permit —
            // after the linearization flip, before the marker release finishes.
            harness.faults.parkRead = { parked, resume };
            yield* Deferred.await(parked);

            // The finalizer holds the permit, so the cancel cannot even be
            // sampled yet — and it never returns an acceptance.
            const cancelling = yield* service
              .cancel({ threadId, attemptId: started.attemptId })
              .pipe(Effect.forkChild);
            yield* Effect.yieldNow;
            expect(cancelling.pollUnsafe()).toBeUndefined();
            yield* Deferred.succeed(resume, undefined);
            // It acquires the permit only after the flip: refused, not accepted.
            expect(yield* Fiber.join(cancelling)).toEqual({ cancelled: false });
            yield* workerExit(harness);
            expect(yield* admissionState(service)).toBe("open");
            expect(yield* service.cancel({ threadId, attemptId: started.attemptId })).toEqual({
              cancelled: false,
            });
          }),
        );
      }),
    );
  });

  describe("resolving ownership during a live attempt", () => {
    it.effect("a live attempt refuses resolution and keeps the observed bytes", () =>
      Effect.gen(function* () {
        const scriptStarted = yield* Deferred.make<void>();
        const releaseScript = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          service: {
            runScript: seamRunScript(
              () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(scriptStarted, undefined);
                  yield* Deferred.await(releaseScript);
                  return passedResult(4711);
                }),
              [],
            ),
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptStarted);

            const corrupt = "{not json";
            yield* fileSystem.writeFileString(harness.markerPath, corrupt);
            const corruptSha = sha256Text(corrupt);
            const corruptResolve = yield* service.resolveOwnership({
              markerSha256: corruptSha,
              acknowledgeUncertainty: true,
            });
            expect(corruptResolve.outcome).toBe("attempt-live");
            expect(corruptResolve.admission).toMatchObject({ state: "busy", threadId });
            expect(yield* fileSystem.readFileString(harness.markerPath)).toBe(corrupt);

            const foreign = ownedMarkerText({
              attemptId: "attempt-other",
              scriptId: "elsewhere",
              pgid: 99,
            });
            yield* fileSystem.writeFileString(harness.markerPath, foreign);
            const foreignResolve = yield* service.resolveOwnership({
              markerSha256: sha256Text(foreign),
              acknowledgeUncertainty: true,
            });
            expect(foreignResolve.outcome).toBe("attempt-live");
            expect(yield* fileSystem.readFileString(harness.markerPath)).toBe(foreign);

            yield* Deferred.succeed(releaseScript, undefined);
          }),
        );
      }),
    );

    it.effect(
      "an unknown ending strands the owner; acknowledging the obstruction never opens the slot",
      () =>
        Effect.gen(function* () {
          const scriptStarted = yield* Deferred.make<void>();
          const releaseScript = yield* Deferred.make<void>();
          const harness = yield* makeHarness({
            service: {
              // PGID 4711 is synthetic; the probe must stay deterministic.
              probeGroup: () => "unknown",
              runScript: seamRunScript(
                () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(scriptStarted, undefined);
                    yield* Deferred.await(releaseScript);
                    return unknownResult(4711);
                  }),
                [],
              ),
            },
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
              yield* Deferred.await(scriptStarted);

              const corrupt = "{not json";
              yield* fileSystem.writeFileString(harness.markerPath, corrupt);
              yield* Deferred.succeed(releaseScript, undefined);
              yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
              yield* workerExit(harness);

              // The stranded owner refuses a new run before the disk is even read.
              const refused = asRejected(
                yield* service.run({ threadId, scriptIds: ["check-a"] }).pipe(Effect.flip),
              );
              expect(refused.reason).toBe("owner-unrecorded");
              expect(yield* admissionState(service)).toBe("owner-corrupt");

              const acknowledged = yield* service.resolveOwnership({
                markerSha256: sha256Text(corrupt),
                acknowledgeUncertainty: true,
              });
              expect(acknowledged.outcome).toBe("acknowledged");
              // The acknowledged bytes never represented the unresolved owner.
              expect(yield* admissionState(service)).toBe("owner-unrecorded");

              const flushed = yield* service.resolveOwnership({
                markerSha256: null,
                acknowledgeUncertainty: false,
              });
              expect(flushed.outcome).toBe("still-unresolved");
              expect(flushed.admission.state).toBe("owner-unresolved");
              if (flushed.admission.state !== "owner-unresolved") return;
              expect(flushed.admission.marker).toMatchObject({
                attemptId: started.attemptId,
                threadId,
                scriptId: "check-a",
                pgid: 4711,
              });

              const opened = yield* service.resolveOwnership({
                markerSha256: flushed.admission.marker.sha256,
                acknowledgeUncertainty: true,
              });
              expect(opened.outcome).toBe("acknowledged");
              expect(yield* admissionState(service)).toBe("open");
            }),
          );
        }),
    );
  });

  describe("unresolved owners and missing marker states", () => {
    it.effect(
      "every missing or mismatched marker state strands the owner until it is re-persisted",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const states = ["absent", "released", "corrupt", "unreadable", "foreign"] as const;
          for (const state of states) {
            const scriptStarted = yield* Deferred.make<void>();
            const releaseScript = yield* Deferred.make<void>();
            const harness = yield* makeHarness({
              scripts: [script("check-a", "echo a")],
              service: {
                // PGID 4711 is synthetic; the probe must stay deterministic.
                probeGroup: () => "unknown",
                runScript: seamRunScript(
                  () =>
                    Effect.gen(function* () {
                      yield* Deferred.succeed(scriptStarted, undefined);
                      yield* Deferred.await(releaseScript);
                      return unknownResult(4711);
                    }),
                  [],
                ),
              },
            });
            const label = `marker state: ${state}`;
            yield* withService(harness, (service) =>
              Effect.gen(function* () {
                const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
                yield* Deferred.await(scriptStarted);

                let obstruction = "";
                if (state === "released") obstruction = releasedMarkerText();
                if (state === "corrupt") obstruction = "{not json";
                if (state === "foreign") {
                  obstruction = ownedMarkerText({
                    attemptId: "attempt-other",
                    scriptId: "elsewhere",
                    pgid: 99,
                  });
                }
                if (state === "absent") {
                  yield* fileSystem.remove(harness.markerPath);
                }
                if (state === "unreadable") {
                  yield* fileSystem.remove(harness.markerPath);
                  yield* fileSystem.makeDirectory(harness.markerPath);
                }
                if (obstruction !== "") {
                  yield* fileSystem.writeFileString(harness.markerPath, obstruction);
                }
                yield* Deferred.succeed(releaseScript, undefined);

                const ended = yield* Deferred.await(
                  harness.terminalRecordWritten(started.attemptId),
                );
                yield* workerExit(harness);
                expect(ended.phase, label).toBe("completed");
                // A run first tries to persist the stranded owner: where the
                // marker is free (absent/released) that flush succeeds and the
                // refusal names the persisted owner; obstructed states keep the
                // memory latch and refuse as owner-unrecorded.
                const flushedOnRun = state === "absent" || state === "released";
                const closedByBeforeRun = {
                  absent: "owner-unrecorded",
                  released: "owner-unrecorded",
                  corrupt: "owner-corrupt",
                  unreadable: "owner-unreadable",
                  foreign: "owner-unresolved",
                }[state];
                expect(yield* admissionState(service), label).toBe(closedByBeforeRun);
                const refused = asRejected(
                  yield* service.run({ threadId, scriptIds: ["check-a"] }).pipe(Effect.flip),
                );
                expect(refused.reason, label).toBe(
                  flushedOnRun ? "owner-unresolved" : "owner-unrecorded",
                );
                const closedByAfterRun = flushedOnRun ? "owner-unresolved" : closedByBeforeRun;
                expect(yield* admissionState(service), label).toBe(closedByAfterRun);
                if (flushedOnRun) {
                  // The persisted owner is the exact stranded one, unchanged.
                  const persisted = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
                  expect(persisted, label).toMatchObject({
                    state: "owned",
                    attemptId: started.attemptId,
                    scriptId: "check-a",
                    pgid: 4711,
                  });
                }

                // Acknowledging whatever obstructs the marker cannot clear the latch.
                if (state === "corrupt" || state === "foreign") {
                  const outcome = yield* service.resolveOwnership({
                    markerSha256: sha256Text(obstruction),
                    acknowledgeUncertainty: true,
                  });
                  expect(outcome.outcome, label).toBe("acknowledged");
                  expect(yield* admissionState(service), label).toBe("owner-unrecorded");
                }
                if (state === "released") {
                  // The obstructing released marker is gone already; its digest
                  // is stale, and the flushed owner keeps the slot closed.
                  const outcome = yield* service.resolveOwnership({
                    markerSha256: sha256Text(obstruction),
                    acknowledgeUncertainty: true,
                  });
                  expect(outcome.outcome, label).toBe("stale");
                  expect(yield* admissionState(service), label).toBe("owner-unresolved");
                }
                if (state === "unreadable") {
                  const outcome = yield* service.resolveOwnership({
                    markerSha256: "b".repeat(64),
                    acknowledgeUncertainty: true,
                  });
                  expect(outcome.outcome, label).toBe("unreadable");
                  expect(yield* admissionState(service), label).toBe("owner-unreadable");
                  yield* fileSystem.remove(harness.markerPath, { recursive: true });
                }

                // Only persisting the exact stranded owner moves the slot forward.
                const flushed = yield* service.resolveOwnership({
                  markerSha256: null,
                  acknowledgeUncertainty: false,
                });
                expect(flushed.outcome, label).toBe("still-unresolved");
                expect(flushed.admission.state, label).toBe("owner-unresolved");
                if (flushed.admission.state !== "owner-unresolved") return;
                expect(flushed.admission.marker, label).toMatchObject({
                  attemptId: started.attemptId,
                  threadId,
                  scriptId: "check-a",
                  pgid: 4711,
                });
                const opened = yield* service.resolveOwnership({
                  markerSha256: flushed.admission.marker.sha256,
                  acknowledgeUncertainty: true,
                });
                expect(opened.outcome, label).toBe("acknowledged");
                expect(yield* admissionState(service), label).toBe("open");
              }),
            );
          }
        }),
    );
  });

  describe("interruption and shutdown", () => {
    it.effect("a service close mid-script cancels the attempt and records the missing result", () =>
      Effect.gen(function* () {
        const scriptStarted = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          service: {
            // Zero grace: the close interrupts the parked worker immediately.
            // This boundary does not claim to test the grace timing itself.
            runScript: seamRunScript(
              () => Deferred.succeed(scriptStarted, undefined).pipe(Effect.andThen(Effect.never)),
              [],
            ),
          },
        });
        const scope = yield* Scope.make("sequential");
        const context = yield* Layer.build(harness.layer).pipe(
          Effect.provideService(Scope.Scope, scope),
        );
        const service = Context.get(context, SelectedChecks.SelectedChecks);
        yield* service.reconcile;
        const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
        yield* Deferred.await(scriptStarted);

        yield* Scope.close(scope, Exit.void);

        // Cancel-first for the shared latch: the close latched the cancel, and
        // the missing result stays recorded as evidence on the cancelled phase.
        const ended = storedReceipt(harness);
        expect(ended).toMatchObject({
          attemptId: started.attemptId,
          phase: "cancelled",
          error: "result-missing",
        });
        expect(ended?.checks[0]?.status).toBe("unproven");
        const marker = yield* readMarkerText(harness);
        expect(JSON.parse(marker ?? "{}")).toMatchObject({
          state: "owned",
          attemptId: started.attemptId,
          scriptId: "check-a",
        });
        expect(yield* admissionState(service)).toBe("owner-unresolved");
        const refused = asRejected(
          yield* service.run({ threadId, scriptIds: ["check-a"] }).pipe(Effect.flip),
        );
        expect(refused.reason).toBe("owner-unresolved");
        const result = yield* service.get(threadId);
        expect(deriveSelectedCheckState(result.record).state).not.toBe("all-selected-passed");
      }),
    );

    it.effect(
      "a passed first check does not release the marker when the second never finishes",
      () =>
        Effect.gen(function* () {
          const secondStarted = yield* Deferred.make<void>();
          let calls = 0;
          const harness = yield* makeHarness({
            service: {
              runScript: (input) =>
                Effect.gen(function* () {
                  if (
                    input.cancelSignal !== undefined &&
                    (yield* Deferred.isDone(input.cancelSignal))
                  ) {
                    return cancelledNotStarted();
                  }
                  calls += 1;
                  if (calls === 1) return passedResult(4711);
                  return yield* Deferred.succeed(secondStarted, undefined).pipe(
                    Effect.andThen(Effect.never),
                  );
                }),
            },
          });
          const scope = yield* Scope.make("sequential");
          const context = yield* Layer.build(harness.layer).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          const service = Context.get(context, SelectedChecks.SelectedChecks);
          yield* service.reconcile;
          const started = yield* service.run({ threadId, scriptIds: ["check-a", "check-b"] });
          yield* Deferred.await(secondStarted);

          yield* Scope.close(scope, Exit.void);

          // Cancel-first for the shared latch; the passed first check and the
          // unproven second stay recorded as evidence.
          const ended = storedReceipt(harness);
          expect(ended).toMatchObject({
            attemptId: started.attemptId,
            phase: "cancelled",
            error: "result-missing",
          });
          expect(ended?.checks.map((check) => check.status)).toEqual(["passed", "unproven"]);
          const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
          expect(marker).toMatchObject({ state: "owned", scriptId: "check-b" });
          expect(yield* admissionState(service)).toBe("owner-unresolved");
        }),
    );

    it.effect("interrupting the registration wait leaves the attempt independent", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        let attemptId = "";
        const gate = yield* gateWrite(1, (command) => {
          if (command.type === "thread.activity.append") {
            attemptId = decodeReceiptSync(command.activity.payload).attemptId;
          }
        });
        const harness = yield* makeHarness({
          onDispatch: gate.onDispatch,
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const starting = yield* service
              .run({ threadId, scriptIds: ["check-a"] })
              .pipe(Effect.forkChild);
            yield* Deferred.await(gate.writing);
            // In this Effect version an interrupt does not join; fork it, then await the exit.
            yield* Fiber.interrupt(starting).pipe(Effect.forkChild({ startImmediately: true }));
            const exit = yield* Fiber.await(starting);
            expect(Exit.isFailure(exit)).toBe(true);

            // The worker never noticed: it registers, runs, and owns the slot.
            yield* Deferred.succeed(gate.finish, undefined);
            expect(attemptId).not.toBe("");
            yield* Deferred.await(harness.terminalRecordWritten(attemptId));
            yield* workerExit(harness);

            expect(yield* service.cancel({ threadId, attemptId })).toEqual({ cancelled: false });
            expect(yield* admissionState(service)).toBe("open");
            const second = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(harness.terminalRecordWritten(second.attemptId));
            yield* workerExit(harness);
          }),
        );
      }),
    );

    it.effect(
      "a scope close across the registered handoff fails registration once and frees the slot",
      () =>
        Effect.gen(function* () {
          const calls: Array<string> = [];
          const threadRead = yield* Deferred.make<void>();
          const releaseThread = yield* Deferred.make<void>();
          let threadReads = 0;
          const harness = yield* makeHarness({
            // Park the worker's own R2 re-read — the read after the slot claim and
            // fork, not the caller's pre-claim snapshot read.
            onThreadRead: Effect.suspend(() => {
              threadReads += 1;
              return threadReads === 2
                ? Deferred.succeed(threadRead, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseThread)),
                  )
                : Effect.void;
            }),
            service: {
              runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls),
            },
          });
          const scope = yield* Scope.make("sequential");
          const context = yield* Layer.build(harness.layer).pipe(
            Effect.provideService(Scope.Scope, scope),
          );
          const service = Context.get(context, SelectedChecks.SelectedChecks);
          yield* service.reconcile;

          const starting = yield* service
            .run({ threadId, scriptIds: ["check-a"] })
            .pipe(Effect.forkChild);
          yield* Deferred.await(threadRead);
          yield* Scope.close(scope, Exit.void);
          yield* Deferred.succeed(releaseThread, undefined);

          // The caller's registration failed with the fixed code; the slot and
          // both Deferreds settled exactly once at the closed instance's worker exit.
          const exit = yield* Fiber.await(starting);
          const rejection = Exit.isSuccess(exit) ? null : Cause.squash(exit.cause);
          expect(rejection).toBeInstanceOf(SelectedChecksRejectedError);
          expect((rejection as SelectedChecksRejectedError).reason).toBe("record-failed");
          expect(yield* readMarkerText(harness)).toBeNull();
          expect(yield* admissionState(service)).toBe("open");

          // A disposed run scope is not a "new server works" proof: a fresh
          // service is.
          const restart = yield* makeHarness({
            service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
          });
          yield* withService(restart, (fresh) =>
            Effect.gen(function* () {
              const second = yield* fresh.run({ threadId, scriptIds: ["check-a"] });
              yield* Deferred.await(restart.terminalRecordWritten(second.attemptId));
              yield* workerExit(restart);
              expect(yield* admissionState(fresh)).toBe("open");
            }),
          );
        }),
    );

    it.effect("a finalizer defect still settles the slot and keeps the unresolved owner", () =>
      Effect.gen(function* () {
        const scriptStarted = yield* Deferred.make<void>();
        const cancelObserved = yield* Deferred.make<void>();
        const releaseScript = yield* Deferred.make<void>();
        const calls: Array<string> = [];
        const gate = yield* gateWrite(3);
        const harness = yield* makeHarness({
          onDispatch: gate.onDispatch,
          service: {
            // PGID 4711 is synthetic; the probe must stay deterministic.
            probeGroup: () => "unknown",
            runScript: seamRunScript(
              (input) =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(scriptStarted, undefined);
                  if (input.cancelSignal === undefined) {
                    return yield* Effect.die("expected the service to pass a cancel signal");
                  }
                  yield* Deferred.await(input.cancelSignal);
                  yield* Deferred.succeed(cancelObserved, undefined);
                  yield* Deferred.await(releaseScript);
                  return unknownResult(4711);
                }),
              calls,
            ),
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptStarted);

            const cancelling = yield* service
              .cancel({ threadId, attemptId: started.attemptId })
              .pipe(Effect.forkChild({ startImmediately: true }));
            yield* Deferred.await(cancelObserved);

            yield* Deferred.succeed(releaseScript, undefined);
            // Write 3 is the result write; the unknown-group enrichment already
            // landed, so the disk carries an owned marker for this exact check.
            yield* Deferred.await(gate.writing);
            harness.faults.dieReads = 1;
            yield* Deferred.succeed(gate.finish, undefined);

            // The disposition's marker read died, but settlement still ran:
            // the worker carries the defect, the accepted canceller returned.
            const exit = yield* workerExit(harness);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
            const polled = cancelling.pollUnsafe();
            if (polled === undefined) {
              // The old defect's signature: the accepted canceller is still
              // parked on `done` after the worker settled. Interrupt only the
              // test's own pending fiber, then fail — never hang the suite.
              yield* Fiber.interrupt(cancelling);
              yield* Fiber.await(cancelling);
              return yield* Effect.fail(
                "the accepted canceller was still pending after the worker settled",
              );
            }
            expect(polled).toEqual(Exit.succeed({ cancelled: true }));
            expect(harness.faults.diedReads).toBe(1);

            // Nor did it open admission: the unresolved owner stays represented
            // by the owned marker, and the terminal record the dead disposition
            // never wrote is shown as stopped, not left looking in progress.
            const markerText = yield* readMarkerText(harness);
            const marker = JSON.parse(markerText ?? "{}");
            expect(marker).toMatchObject({
              state: "owned",
              attemptId: started.attemptId,
              threadId,
              scriptId: "check-a",
              pgid: 4711,
            });
            expect(yield* admissionState(service)).toBe("owner-unresolved");
            const result = yield* service.get(threadId);
            expect(
              result.record.kind === "present" && {
                phase: result.record.receipt.phase,
                error: result.record.receipt.error,
              },
            ).toEqual({ phase: "interrupted", error: "server-stopped" });
            expect(deriveSelectedCheckState(result.record).state).not.toBe("all-selected-passed");

            // The read died before the latch could clear, so acknowledging the
            // still-owned bytes cannot open admission — memory keeps it closed.
            const acknowledged = yield* service.resolveOwnership({
              markerSha256: sha256Text(markerText ?? ""),
              acknowledgeUncertainty: true,
            });
            expect(acknowledged.outcome).toBe("acknowledged");
            expect(acknowledged.admission.state).not.toBe("open");
            expect(acknowledged.admission).toEqual({
              state: "owner-unrecorded",
              owner: {
                attemptId: started.attemptId,
                threadId,
                scriptId: "check-a",
                pgid: 4711,
              },
            });

            // Persisting that exact owner re-closes on the disk record, and a
            // separate resolution of it finally opens admission.
            const flushed = yield* service.resolveOwnership({
              markerSha256: null,
              acknowledgeUncertainty: false,
            });
            expect(flushed.outcome).toBe("still-unresolved");
            expect(flushed.admission).toMatchObject({
              state: "owner-unresolved",
              marker: {
                attemptId: started.attemptId,
                threadId,
                scriptId: "check-a",
                pgid: 4711,
              },
            });
            if (flushed.admission.state !== "owner-unresolved") return;
            const opened = yield* service.resolveOwnership({
              markerSha256: flushed.admission.marker.sha256,
              acknowledgeUncertainty: true,
            });
            expect(opened.outcome).toBe("acknowledged");
            expect(yield* admissionState(service)).toBe("open");
          }),
        );
      }),
    );

    it.effect(
      "a repeated finalizer defect still settles the slot and keeps the owner closed in memory",
      () =>
        Effect.gen(function* () {
          const scriptStarted = yield* Deferred.make<void>();
          const cancelObserved = yield* Deferred.make<void>();
          const releaseScript = yield* Deferred.make<void>();
          const calls: Array<string> = [];
          const gate = yield* gateWrite(3);
          const harness = yield* makeHarness({
            onDispatch: gate.onDispatch,
            service: {
              // PGID 4711 is synthetic; the probe must stay deterministic.
              probeGroup: () => "unknown",
              runScript: seamRunScript(
                (input) =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(scriptStarted, undefined);
                    if (input.cancelSignal === undefined) {
                      return yield* Effect.die("expected the service to pass a cancel signal");
                    }
                    yield* Deferred.await(input.cancelSignal);
                    yield* Deferred.succeed(cancelObserved, undefined);
                    yield* Deferred.await(releaseScript);
                    return unknownResult(4711);
                  }),
                calls,
              ),
            },
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const fileSystem = yield* FileSystem.FileSystem;
              const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
              yield* Deferred.await(scriptStarted);

              const cancelling = yield* service
                .cancel({ threadId, attemptId: started.attemptId })
                .pipe(Effect.forkChild({ startImmediately: true }));
              yield* Deferred.await(cancelObserved);

              yield* Deferred.succeed(releaseScript, undefined);
              yield* Deferred.await(gate.writing);
              // The disk marker is now corrupt and every marker read is armed
              // to die — permanently: the kept memory latch is all that still
              // keeps the unresolved owner closed.
              yield* fileSystem.writeFileString(harness.markerPath, "{");
              harness.faults.dieReads = Infinity;
              yield* Deferred.succeed(gate.finish, undefined);

              const exit = yield* workerExit(harness);
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(true);
              const polled = cancelling.pollUnsafe();
              if (polled === undefined) {
                yield* Fiber.interrupt(cancelling);
                yield* Fiber.await(cancelling);
                return yield* Effect.fail(
                  "the accepted canceller was still pending after the worker settled",
                );
              }
              expect(polled).toEqual(Exit.succeed({ cancelled: true }));
              // With the injector still armed, settlement consumed exactly the
              // one disposition read — no recovery read exists to die again.
              expect(harness.faults.diedReads).toBe(1);
              harness.faults.dieReads = 0;

              expect(yield* readMarkerText(harness)).toBe("{");
              expect(yield* admissionState(service)).toBe("owner-corrupt");
              const result = yield* service.get(threadId);
              expect(
                result.record.kind === "present" && {
                  phase: result.record.receipt.phase,
                  error: result.record.receipt.error,
                },
              ).toEqual({ phase: "interrupted", error: "server-stopped" });
              expect(deriveSelectedCheckState(result.record).state).not.toBe("all-selected-passed");

              // Acknowledging the corrupt bytes writes a released marker, but
              // the kept latch still reports the exact owner, never open.
              const acknowledged = yield* service.resolveOwnership({
                markerSha256: sha256Text("{"),
                acknowledgeUncertainty: true,
              });
              expect(acknowledged.outcome).toBe("acknowledged");
              expect(acknowledged.admission.state).not.toBe("open");
              expect(acknowledged.admission).toEqual({
                state: "owner-unrecorded",
                owner: {
                  attemptId: started.attemptId,
                  threadId,
                  scriptId: "check-a",
                  pgid: 4711,
                },
              });

              const flushed = yield* service.resolveOwnership({
                markerSha256: null,
                acknowledgeUncertainty: false,
              });
              expect(flushed.outcome).toBe("still-unresolved");
              expect(flushed.admission).toMatchObject({
                state: "owner-unresolved",
                marker: {
                  attemptId: started.attemptId,
                  threadId,
                  scriptId: "check-a",
                  pgid: 4711,
                },
              });
              if (flushed.admission.state !== "owner-unresolved") return;
              const opened = yield* service.resolveOwnership({
                markerSha256: flushed.admission.marker.sha256,
                acknowledgeUncertainty: true,
              });
              expect(opened.outcome).toBe("acknowledged");
              expect(yield* admissionState(service)).toBe("open");
            }),
          );
        }),
    );
  });

  describe("ambiguous marker writes", () => {
    it.effect("an uncertain R3 rejects the run and leaves the written bytes owning", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            harness.faults.dirOpen = true;
            const rejected = asRejected(
              yield* service.run({ threadId, scriptIds: ["check-a"] }).pipe(Effect.flip),
            );
            expect(rejected).toBeInstanceOf(SelectedChecksRejectedError);
            expect(rejected.reason).toBe("owner-marker-failed");
            // The worker's own finalizer (marker disposition, slot release) has
            // to finish before the disk and admission speak for the attempt.
            yield* workerExit(harness);
            expect(calls).toEqual([]);
            const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
            expect(marker.state).toBe("owned");
            expect(yield* admissionState(service)).toBe("owner-unresolved");
          }),
        );
      }),
    );

    it.effect(
      "an uncertain re-own keeps the attempt from spawning and the marker from releasing",
      () =>
        Effect.gen(function* () {
          const calls: Array<string> = [];
          const harness = yield* makeHarness({
            service: {
              runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls),
            },
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const atStartObserved = yield* Deferred.make<void>();
              let treeReads = 0;
              harness.controls.observeTree = (cwd) => {
                treeReads += 1;
                if (treeReads === 1) {
                  // The start observation runs after applied R3 and before the
                  // per-check renewal — the exact window to arm the one-shot
                  // post-rename directory-open failure for step b.
                  harness.faults.dirOpen = true;
                  return Deferred.succeed(atStartObserved, undefined).pipe(
                    Effect.as(defaultTree(cwd)),
                  );
                }
                return Effect.succeed(defaultTree(cwd));
              };
              const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
              yield* Deferred.await(atStartObserved);
              yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
              yield* workerExit(harness);

              expect(treeReads).toBe(1);
              expect(harness.faults.dirOpen, "the armed fault was consumed by step b").toBe(false);
              expect(calls).toEqual([]);
              const ended = storedReceipt(harness);
              expect(ended).toMatchObject({ phase: "errored", error: "owner-marker-failed" });
              // The bytes on disk are step b's write, but the attempt's own sha went
              // stale — the finalizer's release was rejected by the disk and the
              // marker stays owned instead of being cleared on stale proof.
              const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
              expect(marker).toMatchObject({ state: "owned", scriptId: "check-a" });
              expect(yield* admissionState(service)).toBe("owner-unresolved");
            }),
          );
        }),
    );

    it.effect("an uncertain unknown-group update keeps the richer marker without stranding", () =>
      Effect.gen(function* () {
        const scriptStarted = yield* Deferred.make<void>();
        const releaseScript = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          service: {
            runScript: seamRunScript(
              () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(scriptStarted, undefined);
                  yield* Deferred.await(releaseScript);
                  return unknownResult(4711);
                }),
              [],
            ),
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptStarted);
            harness.faults.dirOpen = true;
            yield* Deferred.succeed(releaseScript, undefined);
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);

            const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
            expect(marker).toMatchObject({ state: "owned", scriptId: "check-a", pgid: 4711 });
            expect(yield* admissionState(service)).toBe("owner-unresolved");
            const ended = storedReceipt(harness);
            expect(ended?.checks[0]).toMatchObject({ status: "unproven", group: "unknown" });
          }),
        );
      }),
    );

    it.effect("an uncertain final release leaves the decision to the disk", () =>
      Effect.gen(function* () {
        const scriptRan = yield* Deferred.make<void>();
        const releaseAtEnd = yield* Deferred.make<void>();
        let treeReads = 0;
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            harness.controls.observeTree = (cwd) => {
              treeReads += 1;
              return treeReads === 1
                ? Effect.succeed(defaultTree(cwd))
                : Deferred.succeed(scriptRan, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseAtEnd)),
                    Effect.as(defaultTree(cwd)),
                  );
            };
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptRan);
            harness.faults.dirOpen = true;
            yield* Deferred.succeed(releaseAtEnd, undefined);
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);

            const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
            expect(marker).toMatchObject({ state: "released", how: "groups-gone" });
            const result = yield* service.get(threadId);
            expect(deriveSelectedCheckState(result.record)).toEqual({
              state: "all-selected-passed",
              reasons: [],
            });
            expect(yield* admissionState(service)).toBe("open");
          }),
        );
      }),
    );

    it.effect("a failed rename leaves an acknowledged marker's bytes exactly as they were", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const seeded = ownedMarkerText();
            yield* fileSystem.writeFileString(harness.markerPath, seeded);
            harness.faults.rename = true;
            const outcome = yield* service.resolveOwnership({
              markerSha256: sha256Text(seeded),
              acknowledgeUncertainty: true,
            });
            expect(outcome.outcome).toBe("persist-failed");
            expect(yield* fileSystem.readFileString(harness.markerPath)).toBe(seeded);
            expect(yield* admissionState(service)).toBe("owner-unresolved");
            // The temp file the failed write created did not survive.
            const files = yield* fileSystem.readDirectory(harness.stateDir);
            expect(files).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
          }),
        );
      }),
    );

    it.effect("a failing read-back reports persist-failed and shows the written bytes", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const seeded = ownedMarkerText();
            yield* fileSystem.writeFileString(harness.markerPath, seeded);
            // Fail the transition's read-back: the resolve read and the
            // expectation read pass, the confirmation read fails.
            harness.faults.readFailOnArmedCall = 3;
            const outcome = yield* service.resolveOwnership({
              markerSha256: sha256Text(seeded),
              acknowledgeUncertainty: true,
            });
            expect(outcome.outcome).toBe("persist-failed");
            // The rename landed before the failing read-back, so the released
            // bytes are exactly the attempted write — every field exact, and
            // only the wall-clock releasedAt taken from the file itself.
            const text = yield* fileSystem.readFileString(harness.markerPath);
            const written = JSON.parse(text) as Record<string, unknown>;
            expect(written).toEqual({
              version: 1,
              state: "released",
              how: "acknowledged",
              previousSha256: sha256Text(seeded),
              previous: {
                attemptId: "attempt-seed",
                threadId,
                scriptId: null,
                pgid: null,
              },
              releasedAt: written.releasedAt,
            });
            // And the file is exactly the canonical serialization of those bytes.
            expect(JSON.stringify(written)).toBe(text);
            expect(outcome.admission.state).toBe("open");
          }),
        );
      }),
    );

    it.effect("a signal-zero gone release that cannot confirm keeps the outcome honest", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          service: { probeGroup: () => "gone" },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const fileSystem = yield* FileSystem.FileSystem;
            const seeded = ownedMarkerText({ pgid: 999 });
            yield* fileSystem.writeFileString(harness.markerPath, seeded);
            harness.faults.dirOpen = true;
            const outcome = yield* service.resolveOwnership({
              markerSha256: sha256Text(seeded),
              acknowledgeUncertainty: false,
            });
            expect(outcome.outcome).toBe("persist-failed");
            const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
            expect(marker).toMatchObject({ state: "released", how: "gone-observed" });
            expect(outcome.admission.state).toBe("open");
          }),
        );
      }),
    );
  });

  describe("snapshot and repository identity", () => {
    it.effect("the request order wins over the settings order", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-b", "check-a"] });
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            expect(calls).toEqual(["echo b", "echo a"]);
            const ended = storedReceipt(harness);
            expect(ended?.planned.map((check) => check.scriptId)).toEqual(["check-b", "check-a"]);
            const result = yield* service.get(threadId);
            expect(deriveSelectedCheckState(result.record)).toEqual({
              state: "all-selected-passed",
              reasons: [],
            });
          }),
        );
      }),
    );

    it.effect("the snapshot command runs even when settings change after registration", () =>
      Effect.gen(function* () {
        const scriptStarted = yield* Deferred.make<void>();
        const releaseScript = yield* Deferred.make<void>();
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: {
            runScript: seamRunScript(
              () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(scriptStarted, undefined);
                  yield* Deferred.await(releaseScript);
                  return passedResult(4711);
                }),
              calls,
            ),
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptStarted);
            harness.controls.scripts = [script("check-a", "echo CHANGED")];
            yield* Deferred.succeed(releaseScript, undefined);
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));

            expect(calls).toEqual(["echo a"]);
            const ended = storedReceipt(harness);
            // The plan's recorded hash is still the snapshot command's — the
            // change is reported, never retro-applied to the record.
            expect(ended?.planned[0]?.commandSha256).toBe(sha256Text("echo a"));
            const result = yield* service.get(threadId);
            expect(result.changedScriptIds).toEqual(["check-a"]);
          }),
        );
      }),
    );

    it.effect("a worktree thread runs on the worktree's cwd and override-only environment", () =>
      Effect.gen(function* () {
        const calls: Array<ScriptExecutor.ScriptExecutionInput> = [];
        const harness = yield* makeHarness({
          service: {
            runScript: (input) => {
              calls.push(input);
              return Effect.succeed(passedResult(4711));
            },
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            harness.controls.worktreePath = "/tmp/wt-abc";
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));

            expect(calls[0]?.cwd).toBe("/tmp/wt-abc");
            expect(calls[0]?.env).toEqual({
              T3CODE_PROJECT_ROOT: "/workspace",
              T3CODE_WORKTREE_PATH: "/tmp/wt-abc",
            });
            const ended = storedReceipt(harness);
            expect(ended?.context).toMatchObject({
              workspaceRoot: "/workspace",
              worktreePath: "/tmp/wt-abc",
              cwd: "/tmp/wt-abc",
            });
            expect(ended?.context.envSha256).toBe(
              sha256Text(
                JSON.stringify(
                  Object.entries({
                    T3CODE_PROJECT_ROOT: "/workspace",
                    T3CODE_WORKTREE_PATH: "/tmp/wt-abc",
                  }).sort(),
                ),
              ),
            );
          }),
        );
      }),
    );

    it.effect("equal tree oids in different repositories stay unproven", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            // The service freezes one cwd for both endpoint observations, so the
            // fake varies by call index: the same written tree, two different
            // repository identities.
            let treeReads = 0;
            harness.controls.observeTree = () => {
              treeReads += 1;
              return Effect.succeed(
                treeReads === 1
                  ? {
                      kind: "complete" as const,
                      treeOid: TREE_OID,
                      topLevel: "/repo",
                      commonDir: "/repo/.git",
                    }
                  : {
                      kind: "complete" as const,
                      treeOid: TREE_OID,
                      topLevel: "/elsewhere",
                      commonDir: "/elsewhere/.git",
                    },
              );
            };
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);

            // Both endpoints were actually observed, and each kept its own identity.
            expect(treeReads).toBe(2);
            const ended = storedReceipt(harness);
            expect(ended?.tree.repoAtStart).toEqual({ topLevel: "/repo", commonDir: "/repo/.git" });
            expect(ended?.tree.repoAtEnd).toEqual({
              topLevel: "/elsewhere",
              commonDir: "/elsewhere/.git",
            });
            const result = yield* service.get(threadId);
            const derived = deriveSelectedCheckState(result.record);
            expect(derived.state).toBe("incomplete");
            expect(derived.reasons).toContain(
              "the run started and ended in different repositories",
            );
          }),
        );
      }),
    );
  });

  describe("resolveTargetPlan", () => {
    it.effect("resolves the bounded plan with no prior receipt", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const plan = yield* service.resolveTargetPlan({ threadId, scriptIds: ["check-a"] });
            expect(plan).toEqual({
              threadId,
              projectId: ProjectId.make("project-1"),
              threadCreatedAt: startedAt,
              workspaceRoot: "/workspace",
              worktreePath: null,
              cwd: "/workspace",
              shell: process.env.SHELL,
              envSha256: sha256Text(
                JSON.stringify(Object.entries({ T3CODE_PROJECT_ROOT: "/workspace" }).sort()),
              ),
              platform: yield* HostProcessPlatform,
              arch: yield* HostProcessArchitecture,
              planned: [{ scriptId: "check-a", commandSha256: sha256Text("echo a") }],
            });
          }),
        );
      }),
    );

    it.effect("resolves while the turn runs; the run itself still refuses turn-active", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            harness.controls.turnRunning = true;
            const plan = yield* service.resolveTargetPlan({ threadId, scriptIds: ["check-a"] });
            expect(plan.planned.map((check) => check.scriptId)).toEqual(["check-a"]);
            const rejected = asRejected(
              yield* service.run({ threadId, scriptIds: ["check-a"] }).pipe(Effect.flip),
            );
            expect(rejected.reason).toBe("turn-active");
            expect(harness.dispatched).toEqual([]);
          }),
        );
      }),
    );

    it.effect("the planned hash follows the actual current command", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const before = yield* service.resolveTargetPlan({ threadId, scriptIds: ["check-a"] });
            expect(before.planned[0]?.commandSha256).toBe(sha256Text("echo a"));
            harness.controls.scripts = [script("check-a", "echo a2")];
            const after = yield* service.resolveTargetPlan({ threadId, scriptIds: ["check-a"] });
            expect(after.planned[0]?.commandSha256).toBe(sha256Text("echo a2"));
          }),
        );
      }),
    );

    it.effect("a worktree change moves cwd, worktreePath, and the environment digest", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const base = yield* service.resolveTargetPlan({ threadId, scriptIds: ["check-a"] });
            expect(base.cwd).toBe("/workspace");
            harness.controls.worktreePath = "/tmp/wt-abc";
            const worktree = yield* service.resolveTargetPlan({
              threadId,
              scriptIds: ["check-a"],
            });
            expect(worktree.worktreePath).toBe("/tmp/wt-abc");
            expect(worktree.cwd).toBe("/tmp/wt-abc");
            expect(worktree.envSha256).toBe(
              sha256Text(
                JSON.stringify(
                  Object.entries({
                    T3CODE_PROJECT_ROOT: "/workspace",
                    T3CODE_WORKTREE_PATH: "/tmp/wt-abc",
                  }).sort(),
                ),
              ),
            );
            expect(worktree.envSha256).not.toBe(base.envSha256);
          }),
        );
      }),
    );

    it.effect("a missing thread and a missing script still reject", () =>
      Effect.gen(function* () {
        const missingThread = yield* makeHarness({ threadExists: false });
        yield* withService(missingThread, (service) =>
          Effect.gen(function* () {
            const error = yield* service
              .resolveTargetPlan({ threadId, scriptIds: ["check-a"] })
              .pipe(Effect.flip);
            expect(error).toBeInstanceOf(SelectedChecksThreadNotFoundError);
          }),
        );
        const missingScript = yield* makeHarness();
        yield* withService(missingScript, (service) =>
          Effect.gen(function* () {
            const rejected = asRejected(
              yield* service
                .resolveTargetPlan({ threadId, scriptIds: ["check-a", "nope"] })
                .pipe(Effect.flip),
            );
            expect(rejected.reason).toBe("script-not-found");
            expect(rejected.scriptId).toBe("nope");
            expect(missingScript.dispatched).toEqual([]);
          }),
        );
      }),
    );

    it.effect("resolving executes nothing and touches no receipt, tree, or owner", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        let treeReads = 0;
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            harness.controls.observeTree = (cwd) => {
              treeReads += 1;
              return Effect.succeed(defaultTree(cwd));
            };
            const plan = yield* service.resolveTargetPlan({ threadId, scriptIds: ["check-a"] });
            expect(plan.planned).toEqual([
              { scriptId: "check-a", commandSha256: sha256Text("echo a") },
            ]);
            // Zero spawns, zero tree observations, zero dispatched records, zero
            // owner-marker bytes, no worker fiber — the answer came from reads alone.
            expect(calls).toEqual([]);
            expect(treeReads).toBe(0);
            expect(harness.dispatched).toEqual([]);
            expect(yield* readMarkerText(harness)).toBeNull();
            expect(harness.worker.current).toBeNull();
            expect(yield* admissionState(service)).toBe("open");
          }),
        );
      }),
    );

    it.effect("the plan matches one real deterministic run receipt, request order included", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const harness = yield* makeHarness({
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const requested = ["check-b", "check-a"];
            const started = yield* service.run({ threadId, scriptIds: requested });
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);
            const receipt = storedReceipt(harness);
            expect(receipt?.planned.map((check) => check.scriptId)).toEqual(requested);
            expect(calls).toEqual(["echo b", "echo a"]);

            const plan = yield* service.resolveTargetPlan({ threadId, scriptIds: requested });
            // The facade keeps the requested order too — never sorted.
            expect(plan.planned.map((check) => check.scriptId)).toEqual(requested);
            // The hashes are the real commands', and the same ones the run recorded.
            expect(plan.planned.map((check) => check.commandSha256)).toEqual([
              sha256Text("echo b"),
              sha256Text("echo a"),
            ]);
            expect(plan.planned.map((check) => check.commandSha256)).toEqual(
              receipt?.planned.map((check) => check.commandSha256),
            );
            const context = receipt?.context;
            if (context === undefined) throw new Error("expected run receipt context");
            expect({
              projectId: plan.projectId,
              workspaceRoot: plan.workspaceRoot,
              worktreePath: plan.worktreePath,
              cwd: plan.cwd,
              shell: plan.shell,
              envSha256: plan.envSha256,
            }).toEqual(context);
          }),
        );
      }),
    );
  });

  describe("thread incarnation", () => {
    it.effect("a thread recreated after the anchor makes the record malformed", () =>
      Effect.gen(function* () {
        const scriptStarted = yield* Deferred.make<void>();
        const releaseScript = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          service: {
            runScript: seamRunScript(
              () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(scriptStarted, undefined);
                  yield* Deferred.await(releaseScript);
                  return passedResult(4711);
                }),
              [],
            ),
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptStarted);
            // Delete + recreate with the same id while the attempt runs.
            harness.controls.recreated = true;
            harness.controls.threadCreatedAt = "2026-08-20T13:00:00.000Z";
            yield* Deferred.succeed(releaseScript, undefined);
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));

            const result = yield* service.get(threadId);
            expect(result.record.kind).toBe("malformed");
            expect(deriveSelectedCheckState(result.record)).toEqual({
              state: "incomplete",
              reasons: ["the stored record is malformed"],
            });
          }),
        );
      }),
    );

    it.effect("a thread context that changed before R2 stops the attempt with zero spawns", () =>
      Effect.gen(function* () {
        const calls: Array<string> = [];
        const gate = yield* gateWrite(1);
        const harness = yield* makeHarness({
          onDispatch: gate.onDispatch,
          service: { runScript: seamRunScript(() => Effect.succeed(passedResult(4711)), calls) },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const starting = yield* service
              .run({ threadId, scriptIds: ["check-a"] })
              .pipe(Effect.forkChild);
            yield* Deferred.await(gate.writing);
            harness.controls.threadCreatedAt = "2026-08-20T13:00:00.000Z";
            yield* Deferred.succeed(gate.finish, undefined);

            const exit = yield* Fiber.await(starting);
            const rejection = Exit.isSuccess(exit) ? null : Cause.squash(exit.cause);
            expect(rejection).toBeInstanceOf(SelectedChecksRejectedError);
            expect((rejection as SelectedChecksRejectedError).reason).toBe("context-changed");
            expect(calls).toEqual([]);
            const ended = storedReceipt(harness);
            expect(ended).toMatchObject({ phase: "errored", error: "context-changed" });
            expect(yield* readMarkerText(harness)).toBeNull();
          }),
        );
      }),
    );
  });

  describe("restart", () => {
    it.effect("reconcile releases only groups a signal-zero probe proves gone", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        for (const [markerPgid, probe, released] of [
          [5, "gone", true],
          [5, "exists", false],
          [5, "unknown", false],
          [null, "gone", false],
        ] as const) {
          let probes = 0;
          const harness = yield* makeHarness({
            service: {
              probeGroup: () => {
                probes += 1;
                return probe as "gone" | "exists" | "unknown";
              },
            },
          });
          yield* Effect.gen(function* () {
            const service = yield* SelectedChecks.SelectedChecks;
            yield* fileSystem.writeFileString(
              harness.markerPath,
              ownedMarkerText({ pgid: markerPgid }),
            );
            yield* service.reconcile;
            const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
            if (released) {
              expect(marker).toMatchObject({ state: "released", how: "gone-observed" });
            } else {
              expect(marker).toMatchObject({ state: "owned", pgid: markerPgid });
            }
            expect(probes).toBe(markerPgid === null ? 0 : 1);
          }).pipe(Effect.provide(harness.layer));
        }
      }),
    );

    it.effect("reconcile settles a running receipt as interrupted by a restart", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        seedRow(harness, runningReceiptSeed());
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            yield* service.reconcile;
            const ended = storedReceipt(harness);
            expect(ended).toMatchObject({
              attemptId: "attempt-seed",
              revision: 2,
              phase: "interrupted",
              error: "server-restarted",
            });
            expect(ended?.endedAt).not.toBeNull();
            expect(ended?.checks.map((check) => check.status)).toEqual(["unproven"]);
            const result = yield* service.get(threadId);
            expect(result.record.kind === "present" && result.record.receipt.phase).toBe(
              "interrupted",
            );
            expect(deriveSelectedCheckState(result.record).state).toBe("incomplete");
          }),
        );
      }),
    );
  });

  describe("measureCurrent", () => {
    it.effect.skipIf(windowsHost)(
      "the plain get measures nothing and the measured get reads all three fields",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const environment = yield* measuredEnvironment;
              seedRow(harness, completedReceiptSeed(environment));
              let treeReads = 0;
              harness.controls.observeTree = (cwd) => {
                treeReads += 1;
                return Effect.succeed(defaultTree(cwd));
              };

              const plain = yield* service.get(threadId);
              const emptyOptions = yield* service.get(threadId, {});
              expect(treeReads).toBe(0);
              expect(plain).toEqual(emptyOptions);
              expect(plain.treeUnchanged).toBeUndefined();
              expect(plain.contextMatches).toBeUndefined();
              expect(plain.environmentMatches).toBeUndefined();

              const measured = yield* service.get(threadId, { measureCurrent: true });
              expect(treeReads).toBe(1);
              expect(measured.record).toEqual(plain.record);
              expect(measured.treeUnchanged).toBe(true);
              expect(measured.contextMatches).toBe(true);
              expect(measured.environmentMatches).toBe(true);
            }),
          );
        }),
    );

    it.effect.skipIf(windowsHost)("a live running attempt is never measured", () =>
      Effect.gen(function* () {
        const scriptReached = yield* Deferred.make<void>();
        const releaseScript = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          service: {
            runScript: seamRunScript(
              () =>
                Deferred.succeed(scriptReached, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseScript)),
                  Effect.as(passedResult(4711)),
                ),
              [],
            ),
          },
        });
        yield* withService(harness, (service) =>
          Effect.gen(function* () {
            const started = yield* service.run({ threadId, scriptIds: ["check-a"] });
            yield* Deferred.await(scriptReached);
            // Armed only after the worker's own at-start observation, so any
            // further read is the measurement's alone.
            let treeReads = 0;
            harness.controls.observeTree = (cwd) => {
              treeReads += 1;
              return Effect.succeed(defaultTree(cwd));
            };
            const result = yield* service.get(threadId, { measureCurrent: true });
            expect(result.record).toMatchObject({
              kind: "present",
              receipt: { phase: "running", attemptId: started.attemptId },
            });
            expect(result.treeUnchanged).toBeUndefined();
            expect(result.contextMatches).toBeUndefined();
            expect(result.environmentMatches).toBeUndefined();
            expect(treeReads).toBe(0);
            yield* Deferred.succeed(releaseScript, undefined);
            yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
            yield* workerExit(harness);
          }),
        );
      }),
    );

    it.effect.skipIf(windowsHost)(
      "a new attempt committed during measurement drops the stale observations",
      () =>
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const environment = yield* measuredEnvironment;
              seedRow(harness, completedReceiptSeed(environment, { attemptId: "attempt-1" }));
              const entered = yield* Deferred.make<void>();
              const release = yield* Deferred.make<void>();
              let calls = 0;
              harness.controls.observeTree = (cwd) => {
                calls += 1;
                return calls === 1
                  ? Deferred.succeed(entered, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.as(defaultTree(cwd)),
                    )
                  : Effect.succeed(defaultTree(cwd));
              };

              const fiber = yield* service
                .get(threadId, { measureCurrent: true })
                .pipe(Effect.forkChild);
              yield* Deferred.await(entered);
              // A2 lands while the observation is parked: a different attempt on
              // the same fixed row, which is what a new run would write.
              seedRow(
                harness,
                completedReceiptSeed(environment, { attemptId: "attempt-2", revision: 3 }),
                42,
              );
              yield* Deferred.succeed(release, undefined);
              const result = yield* Fiber.join(fiber);
              // The record view is the snapshot the get read; the observations
              // taken against A1 were dropped rather than attached to A2.
              expect(result.record).toMatchObject({
                kind: "present",
                sequence: 1,
                receipt: { attemptId: "attempt-1" },
              });
              expect(result.treeUnchanged).toBeUndefined();
              expect(result.contextMatches).toBeUndefined();
              expect(result.environmentMatches).toBeUndefined();

              const fresh = yield* service.get(threadId, { measureCurrent: true });
              expect(fresh.record).toMatchObject({
                kind: "present",
                sequence: 42,
                receipt: { attemptId: "attempt-2" },
              });
              expect(fresh.treeUnchanged).toBe(true);
              expect(fresh.contextMatches).toBe(true);
              expect(fresh.environmentMatches).toBe(true);
            }),
          );
        }),
    );
  });

  describe("real executor", () => {
    it.effect.skipIf(windowsHost)(
      "one real run in a temp Git repo proves all-selected-passed",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-scx-git-" });
          NodeChildProcess.execFileSync("git", ["init", "-q", repo]);
          NodeChildProcess.execFileSync("git", [
            "-C",
            repo,
            "config",
            "user.email",
            "t3@example.com",
          ]);
          NodeChildProcess.execFileSync("git", ["-C", repo, "config", "user.name", "t3"]);
          yield* fileSystem.writeFileString(NodePath.join(repo, "README.md"), "x");
          NodeChildProcess.execFileSync("git", ["-C", repo, "add", "."]);
          NodeChildProcess.execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);

          const harness = yield* makeHarness({
            workspaceRoot: repo,
            scripts: [script("ok", "true")],
            realGit: true,
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const started = yield* service.run({ threadId, scriptIds: ["ok"] });
              const ended = yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));
              yield* workerExit(harness);
              expect(ended.phase).toBe("completed");
              expect(ended.checks[0]).toMatchObject({ status: "passed", group: "empty" });
              // The executor really spawned: the recorded group id is a real
              // positive pgid.
              const checkPgid = ended.checks[0]?.pgid;
              expect(
                typeof checkPgid === "number" && Number.isSafeInteger(checkPgid) && checkPgid > 0,
              ).toBe(true);

              const result = yield* service.get(threadId);
              expect(deriveSelectedCheckState(result.record)).toEqual({
                state: "all-selected-passed",
                reasons: [],
              });
              expect(yield* admissionState(service)).toBe("open");
              // The release is a tombstone naming the real owner it provably
              // retired, not a deletion. It records the pre-spawn marker, so
              // its pgid is still null.
              const marker = JSON.parse((yield* readMarkerText(harness)) ?? "{}");
              expect(marker).toMatchObject({ state: "released", how: "groups-gone" });
              expect(marker.previous).toEqual({
                attemptId: started.attemptId,
                threadId,
                scriptId: "ok",
                pgid: null,
              });
            }),
          );
        }),
    );

    it.effect.skipIf(windowsHost)(
      "a failed spawn records no command text, in the record or in the logs",
      () =>
        Effect.gen(function* () {
          const MARKER = "t3-secret-marker-9f2";
          const harness = yield* makeHarness({
            scripts: [script("leak", `echo ${MARKER}; true`)],
            service: {
              runScript: (input) =>
                ScriptExecutor.runScript({ ...input, shell: "/nonexistent/t3-shell" }),
            },
          });
          const logs: Array<string> = [];
          const capture = Logger.make(({ message }) => {
            logs.push(String(message));
          });
          yield* withService(harness, (service) =>
            Effect.gen(function* () {
              const started = yield* service.run({ threadId, scriptIds: ["leak"] });
              yield* Deferred.await(harness.terminalRecordWritten(started.attemptId));

              const ended = storedReceipt(harness);
              expect(ended?.checks[0]).toMatchObject({
                status: "unproven",
                exitedBy: "spawn-failed",
                exitCode: null,
                pgid: null,
                group: "not-started",
                failure: "spawn-failed",
              });
              const result = yield* service.get(threadId);
              expect(deriveSelectedCheckState(result.record).state).toBe("incomplete");
            }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))),
          );
          const leaked = (target: string) => target.includes(MARKER);
          expect(leaked(JSON.stringify(harness.dispatched))).toBe(false);
          expect(leaked(logs.join("\n"))).toBe(false);
        }),
    );
  });
});
