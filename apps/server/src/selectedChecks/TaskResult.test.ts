// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  SELECTED_CHECK_RECEIPT_KIND,
  selectedCheckReceiptId,
  SelectedCheckReceipt,
  TaskResultRejectedError,
  ThreadId,
  deriveTaskResultState,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type ProjectScript,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import { OrchestrationCommandStateUnavailableError } from "../orchestration/Errors.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { ProjectionThreadActivityRepositoryLive } from "../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadActivityRepository } from "../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionTurnRepositoryLive } from "../persistence/Layers/ProjectionTurns.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../restartContinuations.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SelectedChecks from "./SelectedChecks.ts";
import * as TaskResult from "./TaskResult.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";

const NOW = "2026-01-01T00:00:00.000Z";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const providerInstanceId = ProviderInstanceId.make("codex");

const sha256Text = (text: string): string =>
  NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

const TEST_SCRIPT: ProjectScript = {
  id: "verify",
  name: "Verify",
  command: "cat marker.txt",
  icon: "play",
  runOnWorktreeCreate: false,
};

const ITEMS = [{ id: "req-verify", text: "The verification check passed", scriptIds: ["verify"] }];

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-task-result");
const TEST_SERVER_VERSION = "0.0.0-taskresult";

/**
 * The real engine, the real projection pipeline, the real SelectedChecks
 * service, and the service under test, all on one SQLite store. The git
 * registry wraps the real GitVcsDriver so `measureCurrent` observes real
 * worktrees; the environment descriptor is fixed so a receipt can name it.
 */
const makeStack = (databasePath?: string) => {
  const persistence = databasePath
    ? makeSqlitePersistenceLive(databasePath)
    : SqlitePersistenceMemory;
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-taskresult-svc-",
  });
  const gitRegistryLayer = Layer.effect(
    VcsDriverRegistry.VcsDriverRegistry,
    Effect.map(
      GitVcsDriver.makeVcsDriver,
      (driver): VcsDriverRegistry.VcsDriverRegistry["Service"] =>
        ({
          get: () => Effect.succeed(driver),
          detect: () => Effect.succeed({ kind: "git" as const, repository: {} as never, driver }),
          resolve: () => Effect.succeed({ kind: "git" as const, repository: {} as never, driver }),
        }) as never,
    ),
  ).pipe(Layer.provide(VcsProcess.layer));
  const environmentLayer = Layer.mock(ServerEnvironment.ServerEnvironment)({
    getDescriptor: Effect.succeed({
      environmentId: TEST_ENVIRONMENT_ID,
      serverVersion: TEST_SERVER_VERSION,
    } as never),
  });
  // mergeAll builds siblings in parallel: the service layers are chained on
  // top of the dependency layer so the engine they resolve is the built one.
  const engineDeps = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provideMerge(restartContinuationsLayer),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ProjectionTurnRepositoryLive),
    Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
    Layer.provideMerge(
      ServerSettingsService.layerTest({
        defaultProjectScripts: [TEST_SCRIPT],
        projectSettingsFolded: true,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(gitRegistryLayer),
    Layer.provideMerge(persistence),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const selectedChecksLayer = Layer.effect(
    SelectedChecks.SelectedChecks,
    SelectedChecks.make(),
  ).pipe(Layer.provide(engineDeps));
  const taskResultLayer = Layer.effect(TaskResult.TaskResult, TaskResult.make).pipe(
    Layer.provide(Layer.mergeAll(engineDeps, selectedChecksLayer)),
  );
  return Layer.mergeAll(engineDeps, selectedChecksLayer, taskResultLayer);
};

/**
 * The service under test sees the decorated service too: `provideMerge` only
 * re-points what consumers resolve later, so `TaskResult` is rebuilt over the
 * merged context. Later entries win a duplicate tag, so the visible engine is
 * the decorator and the rebuilt service captures it as well.
 */
const decoratedStack = <A, E, R>(decoratorLayer: Layer.Layer<A, E, R>) => {
  const base = makeStack();
  const decorated = decoratorLayer.pipe(Layer.provide(base));
  return Layer.mergeAll(
    base,
    decorated,
    Layer.effect(TaskResult.TaskResult, TaskResult.make).pipe(
      Layer.provide(Layer.mergeAll(base, decorated)),
    ),
  );
};

const boot = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const selectedChecks = yield* SelectedChecks.SelectedChecks;
  yield* selectedChecks.reconcile;
  const taskResult = yield* TaskResult.TaskResult;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  return { engine, selectedChecks, taskResult, settings, registry };
});

const initRepo = Effect.fnUntraced(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix });
  NodeChildProcess.execFileSync("git", ["init", "-q", repo]);
  NodeChildProcess.execFileSync("git", ["-C", repo, "config", "user.email", "t3@example.com"]);
  NodeChildProcess.execFileSync("git", ["-C", repo, "config", "user.name", "t3"]);
  yield* fileSystem.writeFileString(NodePath.join(repo, "marker.txt"), "initial\n");
  NodeChildProcess.execFileSync("git", ["-C", repo, "add", "."]);
  NodeChildProcess.execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
  return repo;
});

const observeNow = (registry: VcsDriverRegistry.VcsDriverRegistry["Service"], cwd: string) =>
  Effect.gen(function* () {
    const detected = yield* registry.detect({ cwd });
    const observe = detected?.driver.checkpoints?.observeTree;
    if (observe === undefined) {
      return yield* Effect.die(new Error("the git driver has no tree observer"));
    }
    const observed = yield* observe({ cwd });
    if (observed.kind !== "complete") {
      return yield* Effect.die(new Error("expected a complete tree observation"));
    }
    return observed;
  });

const receiptEnvironment = (): SelectedCheckReceipt["environment"] => ({
  environmentId: TEST_ENVIRONMENT_ID,
  platform: HostProcessPlatform.defaultValue(),
  arch: HostProcessArchitecture.defaultValue(),
  osRelease: NodeOS.release(),
  serverVersion: TEST_SERVER_VERSION,
  nodeVersion: process.version,
});

const passedCheck = (scriptId: string): SelectedCheckReceipt["checks"][number] => ({
  scriptId,
  status: "passed",
  startedAt: NOW,
  endedAt: NOW,
  exitCode: 0,
  exitedBy: "exit",
  exitSignal: null,
  pgid: 4242,
  group: "empty",
  stdout: { bytes: 1, sha256: sha256Text("x") },
  stderr: { bytes: 0, sha256: EMPTY_SHA256 },
  failure: null,
});

/**
 * A completed-attempt receipt that reads current against this fixture's real
 * workspace, scripts, environment, and context: every derived-state gate is
 * the real measurement, nothing is stubbed past it.
 */
const completedReceipt = (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly anchor: number;
  readonly treeOid: string;
  readonly topLevel: string;
  readonly commonDir: string;
  readonly attemptId?: string;
  readonly revision?: number;
  readonly checks?: SelectedCheckReceipt["checks"];
  readonly shell?: string;
}): SelectedCheckReceipt => {
  const env = projectScriptRuntimeEnv({
    project: { cwd: input.workspaceRoot },
    worktreePath: null,
  });
  const repoIdentity = { topLevel: input.topLevel, commonDir: input.commonDir };
  return {
    schemaVersion: 1,
    threadId: input.threadId,
    attemptId: input.attemptId ?? "attempt-1",
    revision: input.revision ?? 0,
    threadAnchorSequence: input.anchor,
    context: {
      projectId: input.projectId,
      workspaceRoot: input.workspaceRoot,
      worktreePath: null,
      cwd: projectScriptCwd({ project: { cwd: input.workspaceRoot }, worktreePath: null }),
      shell: input.shell ?? process.env.SHELL ?? "/bin/sh",
      envSha256: sha256Text(JSON.stringify(Object.entries(env).sort())),
    },
    planned: [
      {
        scriptId: TEST_SCRIPT.id,
        scriptName: TEST_SCRIPT.name,
        commandSha256: sha256Text(TEST_SCRIPT.command),
        timeoutMs: 600_000,
      },
    ],
    environment: receiptEnvironment(),
    tree: {
      atStart: { kind: "complete", treeOid: input.treeOid },
      atEnd: { kind: "complete", treeOid: input.treeOid },
      repoAtStart: repoIdentity,
      repoAtEnd: repoIdentity,
    },
    phase: "completed",
    checks: input.checks ?? [passedCheck(TEST_SCRIPT.id)],
    startedAt: NOW,
    endedAt: NOW,
    error: null,
  };
};

const seedThread = (
  engine: OrchestrationEngineShape,
  input: {
    readonly prefix: string;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly workspaceRoot: string;
  },
) =>
  Effect.gen(function* () {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`${input.prefix}-project`),
      projectId: input.projectId,
      title: "Task result",
      workspaceRoot: input.workspaceRoot,
      createdAt: NOW,
    });
    const created = yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${input.prefix}-thread`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Task result",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    });
    return { incarnation: created.sequence, threadId: input.threadId } as const;
  });

const writeReceipt = (
  engine: OrchestrationEngineShape,
  prefix: string,
  threadId: ThreadId,
  payload: SelectedCheckReceipt,
  revision = 0,
) =>
  engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make(`server:selected-checks:${prefix}-${revision}`),
    threadId,
    activity: {
      id: EventId.make(selectedCheckReceiptId(threadId)),
      tone: "info",
      kind: SELECTED_CHECK_RECEIPT_KIND,
      summary: "Check attempt recorded",
      payload,
      turnId: null,
      createdAt: NOW,
    },
    createdAt: NOW,
  });

const startTurn = (engine: OrchestrationEngineShape, prefix: string, threadId: ThreadId) =>
  engine.dispatch({
    type: "thread.turn.start",
    commandId: CommandId.make(`${prefix}-turn-start`),
    threadId,
    message: {
      messageId: MessageId.make(`${prefix}-message`),
      role: "user",
      text: "work",
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "approval-required",
    createdAt: NOW,
  });

const decodeTerminalReceipt = Schema.decodeUnknownOption(SelectedCheckReceipt);

/**
 * Causally waits for one attempt's terminal record on the domain-event stream:
 * the worker's final durable write is exactly what a `get` reads afterwards.
 */
const awaitTerminalReceipt = (
  events: Stream.Stream<OrchestrationEvent>,
  threadId: ThreadId,
  attemptId: string,
) => {
  const isTerminalFor = (event: OrchestrationEvent) => {
    if (
      event.type !== "thread.activity-appended" ||
      event.payload.threadId !== threadId ||
      event.payload.activity.kind !== SELECTED_CHECK_RECEIPT_KIND
    ) {
      return false;
    }
    const receipt = Option.getOrNull(decodeTerminalReceipt(event.payload.activity.payload));
    return receipt !== null && receipt.attemptId === attemptId && receipt.phase !== "running";
  };
  return events.pipe(
    Stream.filter(isTerminalFor),
    Stream.runHead,
    Effect.flatMap((head) =>
      Option.isSome(head)
        ? Effect.succeed(head.value)
        : Effect.die(new Error("domain events ended before the terminal receipt")),
    ),
  );
};

const asRejected = (error: unknown): TaskResultRejectedError => {
  if (!(error instanceof TaskResultRejectedError)) {
    throw new Error(`expected a task-result rejection, got ${String(error)}`);
  }
  return error;
};

/** One fully provisioned thread plus a requirements record at revision 0. */
const seedWithRequirements = (input: { readonly prefix: string; readonly workspaceRoot: string }) =>
  Effect.gen(function* () {
    const services = yield* boot;
    const projectId = ProjectId.make(`project-${input.prefix}`);
    const threadId = ThreadId.make(`thread-${input.prefix}`);
    const seeded = yield* seedThread(services.engine, {
      prefix: input.prefix,
      projectId,
      threadId,
      workspaceRoot: input.workspaceRoot,
    });
    yield* services.taskResult.setRequirements({
      threadId,
      threadIncarnation: seeded.incarnation,
      expectedRevision: null,
      items: ITEMS,
    });
    return { ...services, projectId, threadId, incarnation: seeded.incarnation };
  });

/** The same plus a passing completed receipt whose measurements all read true. */
const seedAwaitingAcceptance = (input: {
  readonly prefix: string;
  readonly workspaceRoot: string;
}) =>
  Effect.gen(function* () {
    const seeded = yield* seedWithRequirements(input);
    const tree = yield* observeNow(seeded.registry, input.workspaceRoot);
    const receipt = completedReceipt({
      threadId: seeded.threadId,
      projectId: seeded.projectId,
      workspaceRoot: input.workspaceRoot,
      anchor: seeded.incarnation,
      treeOid: tree.treeOid,
      topLevel: tree.topLevel,
      commonDir: tree.commonDir,
    });
    const receiptSequence = yield* writeReceipt(
      seeded.engine,
      input.prefix,
      seeded.threadId,
      receipt,
    ).pipe(Effect.map((written) => written.sequence));
    return { ...seeded, tree, receipt, receiptSequence };
  });

describe("TaskResult", () => {
  effectIt.effect.skipIf(windowsHost)(
    "requirements pin the resolved script hash; stale tuples and unknown threads conflict",
    () =>
      Effect.gen(function* () {
        const repo = yield* initRepo("t3-trs-req-");
        const { engine, taskResult } = yield* boot;
        const projectId = ProjectId.make("project-req");
        const threadId = ThreadId.make("thread-req");
        const seeded = yield* seedThread(engine, {
          prefix: "req",
          projectId,
          threadId,
          workspaceRoot: repo,
        });
        const incarnation = seeded.incarnation;

        const missing = yield* taskResult
          .get({ threadId: ThreadId.make("thread-none") })
          .pipe(Effect.flip);
        expect(missing).toMatchObject({ _tag: "TaskResultThreadNotFoundError" });

        const invalid = yield* taskResult
          .setRequirements({
            threadId,
            threadIncarnation: incarnation,
            expectedRevision: null,
            items: [],
          })
          .pipe(Effect.flip);
        expect(asRejected(invalid).reason).toBe("requirements-invalid");

        const unknownScript = yield* taskResult
          .setRequirements({
            threadId,
            threadIncarnation: incarnation,
            expectedRevision: null,
            items: [{ id: "req-x", text: "x", scriptIds: ["missing-script"] }],
          })
          .pipe(Effect.flip);
        expect(asRejected(unknownScript)).toMatchObject({
          reason: "script-not-found",
          detail: "missing-script",
        });

        const first = yield* taskResult.setRequirements({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: null,
          items: ITEMS,
        });
        expect(first.threadIncarnation).toBe(incarnation);
        expect(first.record).toMatchObject({
          kind: "present",
          record: {
            revision: 0,
            threadIncarnation: incarnation,
            requirements: {
              version: 1,
              checks: [{ scriptId: "verify", commandSha256: sha256Text(TEST_SCRIPT.command) }],
            },
            acceptance: null,
          },
        });

        // Naming a revision the record never had, or an incarnation that is
        // not current, is a conflict, not a write.
        const staleRevision = yield* taskResult
          .setRequirements({
            threadId,
            threadIncarnation: incarnation,
            expectedRevision: 7,
            items: ITEMS,
          })
          .pipe(Effect.flip);
        expect(asRejected(staleRevision).reason).toBe("conflict");
        const staleIncarnation = yield* taskResult
          .setRequirements({
            threadId,
            threadIncarnation: incarnation + 5,
            expectedRevision: 0,
            items: ITEMS,
          })
          .pipe(Effect.flip);
        expect(asRejected(staleIncarnation).reason).toBe("conflict");

        const second = yield* taskResult.setRequirements({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 0,
          items: ITEMS,
        });
        expect(second.record).toMatchObject({
          kind: "present",
          record: {
            revision: 1,
            requirements: { version: 2 },
          },
        });
      }).pipe(Effect.provide(makeStack())),
  );

  effectIt.effect.skipIf(windowsHost)(
    "a failed run refuses acceptance; a passing one goes verified",
    () =>
      Effect.gen(function* () {
        const repo = yield* initRepo("t3-trs-fail-");
        const seeded = yield* seedWithRequirements({ prefix: "fail", workspaceRoot: repo });
        const { engine, taskResult, selectedChecks, threadId, incarnation } = seeded;
        const fileSystem = yield* FileSystem.FileSystem;
        // Subscribed before any run so no record write can be missed.
        const events = yield* engine.subscribeDomainEvents;

        // The real run path: removing the marker makes `cat marker.txt` exit
        // non-zero, so the attempt durably ends in a failed check.
        yield* fileSystem.remove(NodePath.join(repo, "marker.txt"));
        const failedRun = yield* selectedChecks.run({
          threadId,
          scriptIds: [TEST_SCRIPT.id],
        });
        const failedTerminal = yield* awaitTerminalReceipt(events, threadId, failedRun.attemptId);
        const failedView = yield* taskResult.get({ threadId });
        expect(deriveTaskResultState(failedView, false).state).toBe("failed");

        const denied = yield* taskResult
          .accept({
            threadId,
            threadIncarnation: incarnation,
            expectedRevision: 0,
            requirementsVersion: 1,
            checkAttemptId: failedRun.attemptId,
            checkReceiptSequence: failedTerminal.sequence,
          })
          .pipe(Effect.flip);
        expect(asRejected(denied).reason).toBe("not-awaiting-acceptance");

        // The same script passes on a fresh attempt once the marker is back.
        yield* fileSystem.writeFileString(NodePath.join(repo, "marker.txt"), "initial\n");
        const passRun = yield* selectedChecks.run({
          threadId,
          scriptIds: [TEST_SCRIPT.id],
        });
        const passTerminal = yield* awaitTerminalReceipt(events, threadId, passRun.attemptId);
        const awaiting = yield* taskResult.get({ threadId });
        expect(awaiting.checks.treeUnchanged).toBe(true);
        expect(awaiting.checks.environmentMatches).toBe(true);
        expect(awaiting.checks.contextMatches).toBe(true);
        expect(deriveTaskResultState(awaiting, false).state).toBe("awaiting-acceptance");

        const accepted = yield* taskResult.accept({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 0,
          requirementsVersion: 1,
          checkAttemptId: passRun.attemptId,
          checkReceiptSequence: passTerminal.sequence,
        });
        expect(accepted.record).toMatchObject({
          kind: "present",
          record: {
            revision: 1,
            acceptance: {
              requirementsVersion: 1,
              checkAttemptId: passRun.attemptId,
              checkReceiptSequence: passTerminal.sequence,
            },
          },
        });
        expect(deriveTaskResultState(accepted, false).state).toBe("verified");
        // The same tuple can never be accepted twice: it now reads verified.
        const twice = yield* taskResult
          .accept({
            threadId,
            threadIncarnation: incarnation,
            expectedRevision: 1,
            requirementsVersion: 1,
            checkAttemptId: passRun.attemptId,
            checkReceiptSequence: passTerminal.sequence,
          })
          .pipe(Effect.flip);
        expect(asRejected(twice).reason).toBe("not-awaiting-acceptance");
      }).pipe(Effect.provide(makeStack())),
  );

  effectIt.effect.skipIf(windowsHost)(
    "a tree mutation stales the acceptance and a byte-exact restore revives it",
    () =>
      Effect.gen(function* () {
        const repo = yield* initRepo("t3-trs-tree-");
        const fileSystem = yield* FileSystem.FileSystem;
        const seeded = yield* seedAwaitingAcceptance({ prefix: "tree", workspaceRoot: repo });
        const { taskResult, threadId, incarnation } = seeded;
        const accepted = yield* taskResult.accept({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 0,
          requirementsVersion: 1,
          checkAttemptId: "attempt-1",
          checkReceiptSequence: seeded.receiptSequence,
        });
        expect(deriveTaskResultState(accepted, false).state).toBe("verified");

        yield* fileSystem.writeFileString(NodePath.join(repo, "marker.txt"), "mutated\n");
        const mutated = yield* taskResult.get({ threadId });
        expect(mutated.checks.treeUnchanged).toBe(false);
        const staleDerived = deriveTaskResultState(mutated, false);
        expect(staleDerived.state).toBe("needs-confirmation");
        expect(staleDerived.acceptance).toBe("stale");

        // Content-addressed trees: restoring the exact bytes restores the tree.
        yield* fileSystem.writeFileString(NodePath.join(repo, "marker.txt"), "initial\n");
        const restored = yield* taskResult.get({ threadId });
        expect(restored.checks.treeUnchanged).toBe(true);
        const revived = deriveTaskResultState(restored, false);
        expect(revived.acceptance).toBe("current");
        expect(revived.state).toBe("verified");
      }).pipe(Effect.provide(makeStack())),
  );

  effectIt.effect.skipIf(windowsHost)(
    "a script command change and a newer receipt each stale the acceptance",
    () =>
      Effect.gen(function* () {
        const repo = yield* initRepo("t3-trs-drift-");
        const seeded = yield* seedAwaitingAcceptance({ prefix: "drift", workspaceRoot: repo });
        const { engine, taskResult, settings, threadId, incarnation } = seeded;
        yield* taskResult.accept({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 0,
          requirementsVersion: 1,
          checkAttemptId: "attempt-1",
          checkReceiptSequence: seeded.receiptSequence,
        });

        // A project-scoped override changes the resolved command for this
        // project only — the pinned hash no longer matches the current script.
        // The stack seeds `projectSettingsFolded`, so the legacy map is dead
        // weight: the effective path is `projectSettingsOverrides`.
        yield* settings.updateSettings({
          projectSettingsOverrides: {
            [seeded.projectId]: {
              defaultProjectScripts: [{ ...TEST_SCRIPT, command: "cat other.txt" }],
            },
          },
        });
        const drifted = yield* taskResult.get({ threadId });
        expect(drifted.checks.changedScriptIds).toEqual([TEST_SCRIPT.id]);
        const driftedDerived = deriveTaskResultState(drifted, false);
        expect(driftedDerived.state).toBe("needs-confirmation");
        expect(driftedDerived.acceptance).toBe("stale");
        yield* settings.updateSettings({
          projectSettingsOverrides: { [seeded.projectId]: null },
        });

        // A newer committed attempt leaves the old acceptance behind.
        const tree = yield* observeNow(seeded.registry, repo);
        const nextSequence = yield* writeReceipt(
          engine,
          "drift2",
          threadId,
          completedReceipt({
            threadId,
            projectId: seeded.projectId,
            workspaceRoot: repo,
            anchor: incarnation,
            treeOid: tree.treeOid,
            topLevel: tree.topLevel,
            commonDir: tree.commonDir,
            attemptId: "attempt-2",
            revision: 1,
          }),
          1,
        );
        const afterNext = yield* taskResult.get({ threadId });
        const afterNextDerived = deriveTaskResultState(afterNext, false);
        expect(afterNextDerived.acceptance).toBe("stale");
        expect(afterNextDerived.state).toBe("awaiting-acceptance");
        // And the new tuple can itself be accepted.
        const reaccepted = yield* taskResult.accept({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 1,
          requirementsVersion: 1,
          checkAttemptId: "attempt-2",
          checkReceiptSequence: nextSequence.sequence,
        });
        expect(deriveTaskResultState(reaccepted, false).state).toBe("verified");
      }).pipe(Effect.provide(makeStack())),
  );

  effectIt.effect.skipIf(windowsHost)(
    "a pending turn rejects acceptance with the turn-active reason",
    () =>
      Effect.gen(function* () {
        const repo = yield* initRepo("t3-trs-turn-");
        const seeded = yield* seedAwaitingAcceptance({ prefix: "turn", workspaceRoot: repo });
        const { engine, taskResult, threadId, incarnation } = seeded;

        yield* startTurn(engine, "turn", threadId);
        const denied = yield* taskResult
          .accept({
            threadId,
            threadIncarnation: incarnation,
            expectedRevision: 0,
            requirementsVersion: 1,
            checkAttemptId: "attempt-1",
            checkReceiptSequence: seeded.receiptSequence,
          })
          .pipe(Effect.flip);
        expect(asRejected(denied).reason).toBe("turn-active");
      }).pipe(Effect.provide(makeStack())),
  );

  effectIt.effect.skipIf(windowsHost)(
    "a committed turn-start between measure and write makes the engine refuse",
    () =>
      Effect.gen(function* () {
        const parked = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        // The accept write parks inside the engine decorator so a turn-start
        // commits between the service's measurement and its guarded write —
        // the engine's own CAS must refuse it, not the service's judgement.
        const decorator = Layer.effect(
          OrchestrationEngineService,
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            return {
              ...engine,
              dispatch: ((command: OrchestrationCommand, options: unknown) =>
                (options as { taskResultWrite?: { accept?: unknown } } | undefined)?.taskResultWrite
                  ?.accept !== undefined
                  ? Deferred.succeed(parked, undefined).pipe(
                      Effect.andThen(Deferred.await(resume)),
                      Effect.andThen(engine.dispatch(command, options as never)),
                    )
                  : engine.dispatch(command, options as never)) as never,
            } satisfies OrchestrationEngineService["Service"];
          }),
        );
        yield* Effect.gen(function* () {
          const repo = yield* initRepo("t3-trs-race-");
          const seeded = yield* seedAwaitingAcceptance({ prefix: "race", workspaceRoot: repo });
          const { engine, taskResult, threadId, incarnation } = seeded;

          const fiber = yield* taskResult
            .accept({
              threadId,
              threadIncarnation: incarnation,
              expectedRevision: 0,
              requirementsVersion: 1,
              checkAttemptId: "attempt-1",
              checkReceiptSequence: seeded.receiptSequence,
            })
            .pipe(Effect.forkChild);
          // The guarded write is parked inside dispatch; a turn-start commits
          // through the same engine while the observed head is already stale.
          yield* Deferred.await(parked);
          yield* startTurn(engine, "race", threadId);
          yield* Deferred.succeed(resume, undefined);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            // The engine's fixed rejection maps to a plain conflict — never to
            // write-unconfirmed, which would mean the write may have landed.
            const error = Cause.squash(exit.cause);
            expect(error).toBeInstanceOf(TaskResultRejectedError);
            if (error instanceof TaskResultRejectedError) {
              expect(error.reason).toBe("conflict");
              expect(error.detail).toBeUndefined();
            }
          }
        }).pipe(Effect.provide(decoratedStack(decorator)));
      }),
  );

  effectIt.effect.skipIf(windowsHost)(
    "withdraw clears acceptance, and a no-op still validates the tuple",
    () =>
      Effect.gen(function* () {
        const repo = yield* initRepo("t3-trs-withdraw-");
        const seeded = yield* seedAwaitingAcceptance({ prefix: "withdraw", workspaceRoot: repo });
        const { engine, taskResult, threadId, incarnation } = seeded;
        yield* taskResult.accept({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 0,
          requirementsVersion: 1,
          checkAttemptId: "attempt-1",
          checkReceiptSequence: seeded.receiptSequence,
        });

        const withdrawn = yield* taskResult.withdraw({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 1,
        });
        expect(withdrawn.record).toMatchObject({
          kind: "present",
          record: { revision: 2, acceptance: null },
        });
        expect(deriveTaskResultState(withdrawn, false).state).toBe("awaiting-acceptance");

        // A no-op withdraw under a stale tuple is still a conflict — the
        // judgement is only sound when the tuple it read is still true.
        const staleNoop = yield* taskResult
          .withdraw({
            threadId,
            threadIncarnation: incarnation,
            expectedRevision: 0,
          })
          .pipe(Effect.flip);
        expect(asRejected(staleNoop).reason).toBe("conflict");
        const staleNoopIncarnation = yield* taskResult
          .withdraw({
            threadId,
            threadIncarnation: incarnation + 3,
            expectedRevision: 2,
          })
          .pipe(Effect.flip);
        expect(asRejected(staleNoopIncarnation).reason).toBe("conflict");

        const noop = yield* taskResult.withdraw({
          threadId,
          threadIncarnation: incarnation,
          expectedRevision: 2,
        });
        expect(noop.record).toMatchObject({ kind: "present", record: { revision: 2 } });

        // Recreation interleaving: the tuple an old request judged must never
        // combine with a row the new incarnation wrote. The snapshot reads
        // them together, so the stale request sees one coherent state.
        yield* engine.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("withdraw-delete"),
          threadId,
        });
        const recreated = yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("withdraw-create"),
          threadId,
          projectId: seeded.projectId,
          title: "Task result",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
        });
        const incarnation2 = recreated.sequence;
        const staleAfterRecreation = yield* taskResult
          .withdraw({ threadId, threadIncarnation: incarnation, expectedRevision: null })
          .pipe(Effect.flip);
        expect(asRejected(staleAfterRecreation).reason).toBe("conflict");
        // The new incarnation gets its own revision-0 record without
        // acceptance; the old request's tuple still must not combine.
        yield* taskResult.setRequirements({
          threadId,
          threadIncarnation: incarnation2,
          expectedRevision: null,
          items: ITEMS,
        });
        const staleAcrossRecreation = yield* taskResult
          .withdraw({ threadId, threadIncarnation: incarnation, expectedRevision: 0 })
          .pipe(Effect.flip);
        expect(asRejected(staleAcrossRecreation).reason).toBe("conflict");
      }).pipe(Effect.provide(makeStack())),
  );

  effectIt.effect.skipIf(windowsHost)(
    "a transient read failure is a defect, never a permanent rejection",
    () =>
      Effect.gen(function* () {
        let armed: "none" | "plain" | "mixed" = "none";
        const injected = new PersistenceSqlError({
          operation: "TaskResultTest.injected-transient",
          detail: "simulated storage read failure",
        });
        const mixedCause = Cause.combine(Cause.fail(injected), Cause.interrupt());
        const flakyRepo = Layer.effect(
          ProjectionThreadActivityRepository,
          Effect.gen(function* () {
            const repo = yield* ProjectionThreadActivityRepository;
            return {
              ...repo,
              listByThreadId: ((input: unknown) =>
                armed === "plain"
                  ? ((armed = "none"), Effect.fail(injected))
                  : armed === "mixed"
                    ? ((armed = "none"), Effect.failCause(mixedCause))
                    : repo.listByThreadId(input as never)) as never,
            } satisfies ProjectionThreadActivityRepository["Service"];
          }),
        );
        yield* Effect.gen(function* () {
          const repo = yield* initRepo("t3-trs-transient-");
          const seeded = yield* seedAwaitingAcceptance({
            prefix: "transient",
            workspaceRoot: repo,
          });
          armed = "plain";
          const exit = yield* Effect.exit(seeded.taskResult.get({ threadId: seeded.threadId }));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasDies(exit.cause)).toBe(true);
            expect(Cause.squash(exit.cause) instanceof TaskResultRejectedError).toBe(false);
          }

          // A mixed Fail+Interrupt keeps its original reasons in order — the
          // torn read is never a missing incarnation or an absent record.
          armed = "mixed";
          const mixedExit = yield* Effect.exit(
            seeded.taskResult.get({ threadId: seeded.threadId }),
          );
          expect(Exit.isFailure(mixedExit)).toBe(true);
          if (Exit.isFailure(mixedExit)) {
            const originalReasons = Array.from(mixedCause.reasons);
            const deliveredReasons = Array.from(mixedExit.cause.reasons);
            expect(deliveredReasons.length).toBeGreaterThanOrEqual(originalReasons.length);
            for (const [index, original] of originalReasons.entries()) {
              const delivered = deliveredReasons[index]!;
              if (Cause.isFailReason(delivered) && Cause.isFailReason(original)) {
                expect(delivered.error).toBe(original.error);
                expect(delivered.error).toBe(injected);
              } else if (
                !(Cause.isInterruptReason(delivered) && Cause.isInterruptReason(original))
              ) {
                expect.unreachable("delivered reason kinds diverged");
              }
            }
            for (const extra of deliveredReasons.slice(originalReasons.length)) {
              expect(Cause.isInterruptReason(extra)).toBe(true);
            }
            expect(Cause.squash(mixedExit.cause) instanceof TaskResultRejectedError).toBe(false);
          }

          // Disarmed, the same read succeeds: nothing was recorded absent or stale.
          const recovered = yield* seeded.taskResult.get({ threadId: seeded.threadId });
          expect(recovered.record.kind).toBe("present");
        }).pipe(Effect.provide(decoratedStack(flakyRepo)));
      }),
  );

  effectIt.effect.skipIf(windowsHost)(
    "a dispatch failure without the fixed detail reports write-unconfirmed",
    () =>
      Effect.gen(function* () {
        let armed = true;
        const injected = new PersistenceSqlError({
          operation: "TaskResultTest.injected-commit-ack-loss",
          detail: "simulated post-commit failure",
        });
        const decorator = Layer.effect(
          OrchestrationEngineService,
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            return {
              ...engine,
              dispatch: ((command: OrchestrationCommand, options: unknown) =>
                armed && (options as { taskResultWrite?: unknown } | undefined)?.taskResultWrite
                  ? ((armed = false),
                    engine
                      .dispatch(command, options as never)
                      .pipe(Effect.andThen(Effect.fail(injected))))
                  : engine.dispatch(command, options as never)) as never,
            } satisfies OrchestrationEngineService["Service"];
          }),
        );
        yield* Effect.gen(function* () {
          const repo = yield* initRepo("t3-trs-unconfirmed-");
          const { engine, taskResult } = yield* boot;
          const projectId = ProjectId.make("project-unconfirmed");
          const threadId = ThreadId.make("thread-unconfirmed");
          const seeded = yield* seedThread(engine, {
            prefix: "unconfirmed",
            projectId,
            threadId,
            workspaceRoot: repo,
          });

          const failure = yield* taskResult
            .setRequirements({
              threadId,
              threadIncarnation: seeded.incarnation,
              expectedRevision: null,
              items: ITEMS,
            })
            .pipe(Effect.flip);
          const rejection = asRejected(failure);
          expect(rejection.reason).toBe("conflict");
          expect(rejection.detail).toBe("write-unconfirmed");

          // The failure arrived after the real commit: the record did land, and
          // the service never claimed success it could not confirm.
          const view = yield* taskResult.get({ threadId });
          expect(view.record).toMatchObject({ kind: "present", record: { revision: 0 } });
        }).pipe(Effect.provide(decoratedStack(decorator)));
      }),
  );

  effectIt.effect.skipIf(windowsHost)(
    "an interruption inside the write propagates the interrupt cause",
    () =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const injected = new OrchestrationCommandStateUnavailableError({
          commandType: "thread.activity.append",
        });
        const mixedCause = Cause.combine(Cause.fail(injected), Cause.interrupt());
        let behavior: "park" | "mixed" = "park";
        const decorator = Layer.effect(
          OrchestrationEngineService,
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngineService;
            return {
              ...engine,
              dispatch: ((command: OrchestrationCommand, options: unknown) =>
                (options as { taskResultWrite?: unknown } | undefined)?.taskResultWrite !==
                undefined
                  ? behavior === "park"
                    ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.failCause(mixedCause)
                  : engine.dispatch(command, options as never)) as never,
            } satisfies OrchestrationEngineService["Service"];
          }),
        );
        yield* Effect.gen(function* () {
          const repo = yield* initRepo("t3-trs-interrupt-");
          const { engine, taskResult } = yield* boot;
          const seeded = yield* seedThread(engine, {
            prefix: "interrupt",
            projectId: ProjectId.make("project-interrupt"),
            threadId: ThreadId.make("thread-interrupt"),
            workspaceRoot: repo,
          });
          const fiber = yield* taskResult
            .setRequirements({
              threadId: seeded.threadId,
              threadIncarnation: seeded.incarnation,
              expectedRevision: null,
              items: ITEMS,
            })
            .pipe(Effect.forkChild);
          // Parked inside the decorated write: the interruption provably lands
          // at the write boundary, not in an earlier read.
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
          const exit = yield* Fiber.await(fiber);
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.hasInterrupts(exit.cause)).toBe(true);
            expect(Cause.squash(exit.cause) instanceof TaskResultRejectedError).toBe(false);
          }

          // A mixed dispatch cause keeps its original reasons and identity —
          // nothing was decided, and no write is claimed.
          behavior = "mixed";
          const mixedExit = yield* Effect.exit(
            taskResult.setRequirements({
              threadId: seeded.threadId,
              threadIncarnation: seeded.incarnation,
              expectedRevision: null,
              items: ITEMS,
            }),
          );
          expect(Exit.isFailure(mixedExit)).toBe(true);
          if (Exit.isFailure(mixedExit)) {
            const originalReasons = Array.from(mixedCause.reasons);
            const deliveredReasons = Array.from(mixedExit.cause.reasons);
            expect(deliveredReasons.length).toBeGreaterThanOrEqual(originalReasons.length);
            for (const [index, original] of originalReasons.entries()) {
              const delivered = deliveredReasons[index]!;
              if (Cause.isFailReason(delivered) && Cause.isFailReason(original)) {
                expect(delivered.error).toBe(original.error);
                expect(delivered.error).toBe(injected);
              } else if (
                !(Cause.isInterruptReason(delivered) && Cause.isInterruptReason(original))
              ) {
                expect.unreachable("delivered reason kinds diverged");
              }
            }
            for (const extra of deliveredReasons.slice(originalReasons.length)) {
              expect(Cause.isInterruptReason(extra)).toBe(true);
            }
          }
          const view = yield* taskResult.get({ threadId: seeded.threadId });
          expect(view.record.kind).toBe("none");
        }).pipe(Effect.provide(decoratedStack(decorator)));
      }),
  );

  // Two sequential scoped builds on one file: each build owns one server
  // lifetime, closing its scope ends the engine and the connection before the
  // next build — the same restart the production boot performs.
  effectIt.effect.skipIf(windowsHost)(
    "a restart reads and withdraws the durable record from the same file",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-trs-restart-")),
        );
        yield* Effect.gen(function* () {
          const databasePath = NodePath.join(directory, "state.sqlite");
          const repo = NodePath.join(directory, "repo");
          NodeChildProcess.execFileSync("git", ["init", "-q", repo]);
          NodeChildProcess.execFileSync("git", [
            "-C",
            repo,
            "config",
            "user.email",
            "t3@example.com",
          ]);
          NodeChildProcess.execFileSync("git", ["-C", repo, "config", "user.name", "t3"]);
          yield* Effect.promise(() =>
            NodeFSP.writeFile(NodePath.join(repo, "marker.txt"), "initial\n"),
          );
          NodeChildProcess.execFileSync("git", ["-C", repo, "add", "."]);
          NodeChildProcess.execFileSync("git", ["-C", repo, "commit", "-q", "-m", "init"]);
          const projectId = ProjectId.make("project-restart");
          const threadId = ThreadId.make("thread-restart");
          const runStack = <A, E, R>(work: Effect.Effect<A, E, R>) =>
            Effect.scoped(
              Effect.flatMap(Layer.build(Layer.fresh(makeStack(databasePath))), (context) =>
                Effect.provide(work, context),
              ),
            );

          let incarnation = 0;
          let receiptSequence = 0;
          yield* runStack(
            Effect.gen(function* () {
              const { engine, taskResult, registry } = yield* boot;
              const seeded = yield* seedThread(engine, {
                prefix: "restart",
                projectId,
                threadId,
                workspaceRoot: repo,
              });
              incarnation = seeded.incarnation;
              yield* taskResult.setRequirements({
                threadId,
                threadIncarnation: incarnation,
                expectedRevision: null,
                items: ITEMS,
              });
              const tree = yield* observeNow(registry, repo);
              const written = yield* writeReceipt(
                engine,
                "restart",
                threadId,
                completedReceipt({
                  threadId,
                  projectId,
                  workspaceRoot: repo,
                  anchor: incarnation,
                  treeOid: tree.treeOid,
                  topLevel: tree.topLevel,
                  commonDir: tree.commonDir,
                }),
              );
              receiptSequence = written.sequence;
              yield* taskResult.accept({
                threadId,
                threadIncarnation: incarnation,
                expectedRevision: 0,
                requirementsVersion: 1,
                checkAttemptId: "attempt-1",
                checkReceiptSequence: receiptSequence,
              });
            }),
          );

          yield* runStack(
            Effect.gen(function* () {
              const { taskResult } = yield* boot;
              const view = yield* taskResult.get({ threadId });
              expect(view.threadIncarnation).toBe(incarnation);
              expect(view.record).toMatchObject({
                kind: "present",
                record: {
                  revision: 1,
                  threadIncarnation: incarnation,
                  acceptance: {
                    requirementsVersion: 1,
                    checkAttemptId: "attempt-1",
                    checkReceiptSequence: receiptSequence,
                  },
                },
              });
              expect(deriveTaskResultState(view, false).state).toBe("verified");

              const withdrawn = yield* taskResult.withdraw({
                threadId,
                threadIncarnation: incarnation,
                expectedRevision: 1,
              });
              expect(withdrawn.record).toMatchObject({
                kind: "present",
                record: { revision: 2, acceptance: null },
              });
              expect(deriveTaskResultState(withdrawn, false).state).toBe("awaiting-acceptance");
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
          ),
        );
      }),
  );
});
