import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as Keybindings from "./keybindings.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionTurnRepositoryLive } from "./persistence/Layers/ProjectionTurns.ts";
import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { PersistenceSqlError } from "./persistence/Errors.ts";
import * as ProjectMemorySendGate from "./memory/ProjectMemorySendGate.ts";
import {
  type CommitProjectMemoryDispatchInput,
  ProjectMemorySendLedger,
  type ProjectMemorySendSettleResult,
  layer as projectMemorySendLedgerLayer,
} from "./persistence/ProjectMemorySendLedger.ts";
import * as ProviderSafetyObservations from "./persistence/ProviderSafetyObservations.ts";
import { layer as restartContinuationsLayer } from "./restartContinuations.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import * as ReleaseVerification from "./releaseVerification/ReleaseVerification.ts";
import * as SelectedChecks from "./selectedChecks/SelectedChecks.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("resolveAutoBootstrapWelcomeTargets returns existing project and thread ids", () => {
  const bootstrapProjectId = ProjectId.make("project-startup-bootstrap");
  const bootstrapThreadId = ThreadId.make("thread-startup-bootstrap");

  return Effect.gen(function* () {
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getDeletedWorktreeThreads: () => Effect.die("unused"),
        listThreadsWithPullRequests: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeedSome({
            id: bootstrapProjectId,
            title: "Startup Project",
            workspaceRoot: "/tmp/startup-project",
            defaultModelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: DEFAULT_MODEL,
            },
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            deletedAt: null,
          }),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeedSome(bootstrapThreadId),
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeedNone,
        getFullThreadDiffContext: () => Effect.succeedNone,
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.deepStrictEqual(targets, {
      bootstrapProjectId,
      bootstrapThreadId,
      bootstrapProjectCreated: false,
      bootstrapThreadCreated: false,
    });
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  });
});

it.effect.each([
  {
    existing: false,
    machineModel: null,
    projectModel: null,
    machineMode: "full-access",
    projectMode: null,
  },
  {
    existing: false,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "approval-required",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: null,
    machineMode: "auto",
    projectMode: null,
  },
  {
    existing: true,
    machineModel: "claude-sonnet-4-6",
    projectModel: "gpt-5.4",
    machineMode: "full-access",
    projectMode: "auto-accept-edits",
  },
] as const)("auto-bootstrap model and permissions precedence: %j", (options) =>
  Effect.gen(function* () {
    const { existing, machineModel, projectModel, machineMode, projectMode } = options;
    const machineSelection = machineModel
      ? { instanceId: ProviderInstanceId.make("claude-code"), model: machineModel }
      : null;
    const projectSelection = projectModel
      ? { instanceId: ProviderInstanceId.make("codex"), model: projectModel }
      : null;
    const dispatchCalls = yield* Ref.make<
      ReadonlyArray<{
        readonly type: string;
        readonly defaultModelSelection?: unknown;
        readonly modelSelection?: unknown;
        readonly runtimeMode?: unknown;
      }>
    >([]);
    const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(
        ServerSettings.layerTest({
          defaultModelSelection: machineSelection,
          defaultRuntimeMode: machineMode,
          projectSettingsOverrides:
            existing && projectSelection
              ? {
                  [ProjectId.make("existing-project")]: {
                    defaultModelSelection: projectSelection,
                    ...(projectMode ? { defaultRuntimeMode: projectMode } : {}),
                  },
                }
              : {},
        }),
      ),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getDeletedWorktreeThreads: () => Effect.die("unused"),
        listThreadsWithPullRequests: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () =>
          Effect.succeed(
            existing
              ? Option.some({
                  id: ProjectId.make("existing-project"),
                  title: "Startup Project",
                  workspaceRoot: "/tmp/startup-project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                  deletedAt: null,
                })
              : Option.none(),
          ),
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeedNone,
        getFullThreadDiffContext: () => Effect.succeedNone,
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provide(NodeServices.layer),
    );

    assert.equal(typeof targets.bootstrapProjectId, "string");
    assert.equal(typeof targets.bootstrapThreadId, "string");
    assert.equal(targets.bootstrapProjectCreated, !existing);
    assert.equal(targets.bootstrapThreadCreated, true);
    const commands = yield* Ref.get(dispatchCalls);
    assert.deepStrictEqual(
      commands.map((command) => command.type),
      existing ? ["thread.create"] : ["project.create", "thread.create"],
    );
    if (!existing) assert.equal("defaultModelSelection" in commands[0]!, false);
    assert.equal(commands.at(-1)?.runtimeMode, projectMode ?? machineMode);
    assert.deepStrictEqual(
      commands.at(-1)?.modelSelection,
      projectSelection ??
        machineSelection ?? {
          instanceId: ProviderInstanceId.make("codex"),
          model: DEFAULT_MODEL,
        },
    );
  }),
);

it.effect(
  "resolveAutoBootstrapWelcomeTargets preserves a project created before thread failure",
  () =>
    Effect.gen(function* () {
      const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const targets = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
        Effect.provide(ServerSettings.layerTest()),
        Effect.provideService(ServerConfig.ServerConfig, {
          cwd: "/tmp/startup-project",
          autoBootstrapProjectFromCwd: true,
        } as never),
        Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          getUserInputActivity: () => Effect.die("unused"),
          listActivitiesByKind: () => Effect.succeed([]),
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getDeletedWorktreeThreads: () => Effect.die("unused"),
          listThreadsWithPullRequests: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getEventReplayStats: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
          getProjectShells: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("thread lookup failed"),
          getImportedAgentSessionSources: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.succeedNone,
          getFullThreadDiffContext: () => Effect.succeedNone,
          getThreadRuntimeContext: () => Effect.die("unused"),
          getTurnStartMessage: () => Effect.die("unused"),
          getThreadShellById: () => Effect.die("unused"),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
          searchThreads: () => Effect.succeed({ matches: [] }),
        }),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused thread replay stats"),
          dispatch: (command) =>
            Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
              Effect.as({ sequence: 1 }),
            ),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
        Effect.provide(NodeServices.layer),
      );

      assert.equal(typeof targets.bootstrapProjectId, "string");
      assert.equal(targets.bootstrapProjectCreated, true);
      assert.equal(targets.bootstrapThreadId, undefined);
      assert.equal(targets.bootstrapThreadCreated, undefined);
      assert.deepStrictEqual(yield* Ref.get(dispatchCalls), ["project.create"]);
    }),
);

it.effect("resolveAutoBootstrapWelcomeTargets preserves typed UUID generation failures", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const uuidError = PlatformError.systemError({
      _tag: "Unknown",
      module: "Crypto",
      method: "randomUUIDv4",
      description: "UUID generation unavailable",
    });
    const dispatchCalls = yield* Ref.make<ReadonlyArray<string>>([]);

    const error = yield* ServerRuntimeStartup.resolveAutoBootstrapWelcomeTargets.pipe(
      Effect.provide(ServerSettings.layerTest()),
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
        autoBootstrapProjectFromCwd: true,
      } as never),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getUserInputActivity: () => Effect.die("unused"),
        listActivitiesByKind: () => Effect.succeed([]),
        getCommandReadModel: () => Effect.die("unused"),
        getSnapshot: () => Effect.die("unused"),
        getShellSnapshot: () => Effect.die("unused"),
        getDeletedWorktreeThreads: () => Effect.die("unused"),
        listThreadsWithPullRequests: () => Effect.die("unused"),
        getArchivedShellSnapshot: () => Effect.die("unused"),
        getSnapshotSequence: () => Effect.die("unused"),
        getCounts: () => Effect.die("unused"),
        getEventReplayStats: () => Effect.die("unused"),
        getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
        getProjectShells: () => Effect.die("unused"),
        getProjectShellById: () => Effect.die("unused"),
        getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
        getImportedAgentSessionSources: () => Effect.die("unused"),
        getThreadCheckpointContext: () => Effect.succeedNone,
        getFullThreadDiffContext: () => Effect.succeedNone,
        getThreadRuntimeContext: () => Effect.die("unused"),
        getTurnStartMessage: () => Effect.die("unused"),
        getThreadShellById: () => Effect.die("unused"),
        getThreadDetailById: () => Effect.die("unused"),
        getThreadDetailSnapshot: () => Effect.die("unused"),
        searchThreads: () => Effect.succeed({ matches: [] }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused thread replay stats"),
        dispatch: (command) =>
          Ref.update(dispatchCalls, (calls) => [...calls, command.type]).pipe(
            Effect.as({ sequence: 1 }),
          ),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } satisfies OrchestrationEngine.OrchestrationEngineService["Service"]),
      Effect.provideService(Crypto.Crypto, {
        ...crypto,
        randomUUIDv4: Effect.fail(uuidError),
      }),
      Effect.flip,
    );

    assert.strictEqual(error, uuidError);
    assert.deepStrictEqual(yield* Ref.get(dispatchCalls), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("completeAutoBootstrapWelcome settles failures without bootstrap targets", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.fail("bootstrap failed"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles unexpected defects", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(
      Effect.die("bootstrap defect"),
    );

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

it.effect("completeAutoBootstrapWelcome settles an empty bootstrap result", () =>
  Effect.gen(function* () {
    const completion = yield* ServerRuntimeStartup.completeAutoBootstrapWelcome(Effect.succeed({}));

    assert.deepStrictEqual(completion, { bootstrapStatus: "complete" });
  }),
);

const STARTUP_ORDERING_EMPTY_SHELL_SNAPSHOT = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const STARTUP_RECON_NOW_ISO = "2026-10-11T09:00:00.000Z";
const STARTUP_RECON_NOW = DateTime.makeUnsafe(STARTUP_RECON_NOW_ISO);
const STARTUP_RECON_PROJECT_ID = "project-recon";
const STARTUP_RECON_THREAD_ID = "thread-recon";
const STARTUP_RECON_PROVIDER_ID = ProviderInstanceId.make("pi-recon");

const makeIsolatedLedgerLayer = (dbPath: string) =>
  Layer.fresh(
    projectMemorySendLedgerLayer.pipe(Layer.provideMerge(makeSqlitePersistenceLive(dbPath))),
  );

const runIsolatedLedger = <A, E, R>(
  dbPath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient | ProjectMemorySendLedger>,
) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(makeIsolatedLedgerLayer(dbPath)), (context) =>
      Effect.provide(effect, context),
    ),
  );

const seedReconProject = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${STARTUP_RECON_NOW_ISO}, ${STARTUP_RECON_NOW_ISO}, NULL)
    `;
  });

const seedReconThread = (projectId: string, threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (
        ${threadId}, ${projectId}, 'Thread', '{}', 'full-access', 'default',
        ${STARTUP_RECON_NOW_ISO}, ${STARTUP_RECON_NOW_ISO}, NULL
      )
    `;
  });

const seedReconMessage = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${threadId}, NULL, 'user', 'text', 0, ${STARTUP_RECON_NOW_ISO}, ${STARTUP_RECON_NOW_ISO})
    `;
  });

const seedReconMemory = (memoryId: string, projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_memories (
        memory_id, project_id, kind, title, body, version,
        origin_type, origin_thread_id, origin_message_id,
        valid_until, estimated_tokens, created_at, updated_at
      )
      VALUES (
        ${memoryId}, ${projectId}, 'fact', 'Runbook', 'Body',
        1, 'manual', NULL, NULL, NULL, 10, ${STARTUP_RECON_NOW_ISO}, ${STARTUP_RECON_NOW_ISO}
      )
    `;
  });

const reconCommitInput = (
  messageId: string,
  overrides: { readonly memoryId?: string } = {},
): CommitProjectMemoryDispatchInput => ({
  threadId: ThreadId.make(STARTUP_RECON_THREAD_ID),
  messageId: MessageId.make(messageId),
  projectId: ProjectId.make(STARTUP_RECON_PROJECT_ID),
  providerInstanceId: STARTUP_RECON_PROVIDER_ID,
  items: [
    { memoryId: ProjectMemoryId.make(overrides.memoryId ?? "mem-recon"), selectedVersion: 1 },
  ],
  now: STARTUP_RECON_NOW,
});

const reconAttemptRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly attemptSeq: number;
    readonly messageId: string;
    readonly ownerInstanceId: string;
    readonly state: string;
    readonly settledAt: string | null;
  }>`
    SELECT attempt_seq AS "attemptSeq", message_id AS "messageId",
           owner_instance_id AS "ownerInstanceId", state,
           settled_at AS "settledAt"
    FROM project_memory_send_attempts
    ORDER BY attempt_seq ASC
  `;
});

const reconItemCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM project_memory_send_items
  `;
  return rows[0]?.count ?? 0;
});

const seedPreviousOwnerRows = (dbPath: string) =>
  runIsolatedLedger(
    dbPath,
    Effect.gen(function* () {
      const ledger = yield* ProjectMemorySendLedger;
      yield* seedReconProject(STARTUP_RECON_PROJECT_ID);
      yield* seedReconThread(STARTUP_RECON_PROJECT_ID, STARTUP_RECON_THREAD_ID);
      yield* seedReconMemory("mem-recon", STARTUP_RECON_PROJECT_ID);
      for (const messageId of ["message-m1", "message-m2", "message-m3"]) {
        yield* seedReconMessage(STARTUP_RECON_THREAD_ID, messageId);
      }

      const m1 = yield* ledger.commitDispatch(reconCommitInput("message-m1"));
      const m2 = yield* ledger.commitDispatch(reconCommitInput("message-m2"));
      const m3 = yield* ledger.commitDispatch(reconCommitInput("message-m3"));
      if (m1.status !== "committed" || m2.status !== "committed" || m3.status !== "committed") {
        return yield* Effect.die("expected committed seed rows");
      }
      yield* ledger.settle({
        attemptSeq: m2.attemptSeq,
        outcome: "provider_accepted",
        now: STARTUP_RECON_NOW,
      });
      yield* ledger.settle({
        attemptSeq: m3.attemptSeq,
        outcome: "external_send_unknown",
        now: STARTUP_RECON_NOW,
      });
      return { m1Seq: m1.attemptSeq, m2Seq: m2.attemptSeq, m3Seq: m3.attemptSeq };
    }),
  );

const makeNonBlockingSelectedChecksDeferreds = Effect.gen(function* () {
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  yield* Deferred.succeed(release, undefined);
  return { entered, release };
});

const makeReconFileDbPath = (prefix: string) => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  return { tempDir, dbPath: NodePath.join(tempDir, "state.sqlite") };
};

type StartupPersistenceLayer =
  | typeof SqlitePersistenceMemory
  | ReturnType<typeof makeSqlitePersistenceLive>;

const makeProductionShapedMemoryLayers = (
  persistence: StartupPersistenceLayer,
  ledgerDecorator?: (
    service: ProjectMemorySendLedger["Service"],
  ) => ProjectMemorySendLedger["Service"],
) => {
  const realMemoryLayers = ProjectMemorySendGate.layer.pipe(
    Layer.provideMerge(projectMemorySendLedgerLayer),
    Layer.provideMerge(persistence),
  );
  if (ledgerDecorator === undefined) {
    return realMemoryLayers;
  }
  return Layer.effect(
    ProjectMemorySendLedger,
    Effect.map(ProjectMemorySendLedger, ledgerDecorator),
  ).pipe(Layer.provideMerge(realMemoryLayers));
};

interface StartupOrderingFixtureInput {
  readonly reconcilePhases: Ref.Ref<ReadonlyArray<string>>;
  readonly selectedChecksReconcileEntered: Deferred.Deferred<void>;
  readonly selectedChecksReconcileRelease: Deferred.Deferred<void>;
  readonly persistence: StartupPersistenceLayer;
  readonly memoryLayers: ReturnType<typeof makeProductionShapedMemoryLayers>;
  readonly startupOptions?: {
    readonly activate?: Effect.Effect<void>;
    readonly awaitAuxiliaryParked?: Effect.Effect<void>;
    readonly abort?: (error: ServerRuntimeStartup.ServerRuntimeStartupError) => Effect.Effect<void>;
  };
  readonly orchestrationReactorStart?: () => Effect.Effect<void>;
  readonly serverConfigPath: string;
  readonly serverConfigPrefix?: string;
}

const buildStartupOrderingStartupLayer = (input: StartupOrderingFixtureInput) => {
  const projectionQueryLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getUserInputActivity: () => Effect.die("unused"),
    listActivitiesByKind: () => Effect.succeed([]),
    getCommandReadModel: () => Effect.succeed({ threads: [] } as never),
    getSnapshot: () => Effect.succeed({ threads: [] } as never),
    getShellSnapshot: () => Effect.succeed(STARTUP_ORDERING_EMPTY_SHELL_SNAPSHOT),
    getArchivedShellSnapshot: () => Effect.succeed(STARTUP_ORDERING_EMPTY_SHELL_SNAPSHOT),
    getDeletedWorktreeThreads: () => Effect.succeed([]),
    listThreadsWithPullRequests: () => Effect.succeed([]),
    getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
    getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
    getEventReplayStats: () => Effect.succeed({ eventCount: 0, payloadBytes: 0 }),
    getActiveProjectByWorkspaceRoot: () => Effect.succeedNone,
    getProjectShells: () => Effect.succeed([]),
    getProjectShellById: () => Effect.succeedNone,
    getFirstActiveThreadIdByProjectId: () => Effect.succeedNone,
    getImportedAgentSessionSources: () => Effect.succeed([]),
    getThreadCheckpointContext: () => Effect.succeedNone,
    getFullThreadDiffContext: () => Effect.succeedNone,
    getThreadRuntimeContext: () => Effect.die("unused"),
    getTurnStartMessage: () => Effect.die("unused"),
    getThreadShellById: () => Effect.succeedNone,
    getThreadDetailById: () => Effect.succeedNone,
    getThreadDetailSnapshot: () => Effect.succeedNone,
    searchThreads: () => Effect.succeed({ matches: [] }),
  });

  const providerReconcileSupport = Layer.mergeAll(
    input.persistence,
    ProviderSafetyObservations.layer.pipe(Layer.provide(input.persistence)),
    ProjectionTurnRepositoryLive.pipe(Layer.provide(input.persistence)),
    restartContinuationsLayer,
    projectionQueryLayer,
    Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      readThreadEvents: () => Stream.empty,
      getThreadReplayStats: () => Effect.die("unused thread replay stats"),
      dispatch: () => Effect.succeed({ sequence: 0 }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      latestSequence: Effect.succeed(0),
    }),
    Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({
      getBinding: () => Effect.succeedNone,
      upsert: () => Effect.void,
      upsertIf: () => Effect.die("unused"),
      upsertIfCurrent: () => Effect.die("unused"),
      recordImportedTranscript: () => Effect.die("unused"),
      getProvider: () => Effect.die("unused"),
      listThreadIds: () => Effect.succeed([]),
      listBindings: () => Effect.succeed([]),
    }),
  );

  const selectedChecksMock = Layer.succeed(SelectedChecks.SelectedChecks, {
    get: () => Effect.die("unused"),
    resolveTargetPlan: () => Effect.die("unexpected resolveTargetPlan call"),
    run: () => Effect.die("unused"),
    cancel: () => Effect.die("unused"),
    resolveOwnership: () => Effect.die("unused"),
    reconcile: Effect.gen(function* () {
      yield* Ref.update(input.reconcilePhases, (phases) => [
        ...phases,
        "selected-checks.reconcile:entered",
      ]);
      yield* Deferred.succeed(input.selectedChecksReconcileEntered, undefined);
      yield* Deferred.await(input.selectedChecksReconcileRelease);
      yield* Ref.update(input.reconcilePhases, (phases) => [
        ...phases,
        "selected-checks.reconcile:finished",
      ]);
    }),
  });

  const startupDependencies = Layer.mergeAll(
    providerReconcileSupport,
    selectedChecksMock,
    input.memoryLayers,
    Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
    ServerSettings.layerTest(),
    Layer.succeed(OrchestrationReactor.OrchestrationReactor, {
      start: input.orchestrationReactorStart ?? (() => Effect.void),
    }),
    Layer.succeed(ProviderSessionReaper.ProviderSessionReaper, {
      start: () => Effect.void,
    }),
    Layer.mock(ReleaseVerification.ReleaseVerification)({
      reconcile: Ref.update(input.reconcilePhases, (phases) => [
        ...phases,
        "release-verifications.reconcile:entered",
      ]),
    }),
    ServerLifecycleEvents.layer,
    Layer.succeed(ServerEnvironment.ServerEnvironment, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-startup-scx")),
      getDescriptor: Effect.succeed({
        environmentId: EnvironmentId.make("environment-startup-scx"),
        label: "Startup selected-checks test",
        serverVersion: "0.0.0-test",
        platform: { os: "darwin", arch: "arm64" },
        capabilities: {},
      } as never),
    }),
    Layer.mock(EnvironmentAuth.EnvironmentAuth)({
      issueStartupPairingUrl: (baseUrl: string) => Effect.succeed(`${baseUrl}/pair`),
    }),
    Layer.mock(ExternalLauncher.ExternalLauncher)({
      launchBrowser: () => Effect.void,
    }),
    Layer.succeed(ServiceLauncherClient.ServiceLauncherClient, {
      managed: false,
      requestUpdate: () => Effect.die("unused"),
      prepareTrial: Effect.undefined,
    }),
    Layer.succeed(
      HttpServer.HttpServer,
      HttpServer.HttpServer.of({
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
      }),
    ),
    AnalyticsService.layerTest,
    Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    Layer.succeed(ProviderService.ProviderService, {
      previewSubmissionRoute: () => Effect.die("unused"),
      startSession: () => Effect.die("unused"),
      sendTurn: () => Effect.die("unused"),
      compactThread: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.die("unused"),
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.die("unused"),
      assertConversationRollbackSupported: () => Effect.die("unused"),
      getInstanceInfo: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      uploadFeedback: () => Effect.die("unused"),
      streamEvents: Stream.empty,
    }),
    ServerConfig.layerTest(input.serverConfigPath, {
      prefix: input.serverConfigPrefix ?? "t3-scx-",
    }),
  );

  return ServerRuntimeStartup.layerWithOptions(
    input.startupOptions ?? {
      activate: Effect.void,
      awaitAuxiliaryParked: Effect.void,
    },
  ).pipe(Layer.provideMerge(startupDependencies));
};

it.layer(NodeServices.layer)("selected checks startup", (it) => {
  it.effect("finishes selected-checks reconciliation before opening the command gate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reconcilePhases = yield* Ref.make<ReadonlyArray<string>>([]);
        const selectedChecksReconcileEntered = yield* Deferred.make<void>();
        const selectedChecksReconcileRelease = yield* Deferred.make<void>();
        const commandReadyReceipt = yield* Deferred.make<void>();

        const startupLayer = buildStartupOrderingStartupLayer({
          reconcilePhases,
          selectedChecksReconcileEntered,
          selectedChecksReconcileRelease,
          persistence: SqlitePersistenceMemory,
          memoryLayers: makeProductionShapedMemoryLayers(SqlitePersistenceMemory),
          serverConfigPath: "/tmp/startup-selected-checks",
        });

        yield* Effect.gen(function* () {
          const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
          const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
          const commandFiber = yield* startup
            .enqueueCommand(Deferred.succeed(commandReadyReceipt, undefined))
            .pipe(Effect.forkScoped);
          yield* startup.markHttpListening;
          yield* Deferred.await(selectedChecksReconcileEntered);

          const phases = yield* Ref.get(reconcilePhases);
          const releaseIndex = phases.indexOf("release-verifications.reconcile:entered");
          const selectedIndex = phases.indexOf("selected-checks.reconcile:entered");
          assert.isTrue(releaseIndex >= 0);
          assert.isTrue(selectedIndex > releaseIndex);
          assert.isFalse(yield* Deferred.isDone(commandReadyReceipt));
          assert.isFalse(
            (yield* lifecycle.snapshot).events.some((event) => event.type === "ready"),
          );

          yield* Deferred.succeed(selectedChecksReconcileRelease, undefined);
          yield* Fiber.join(commandFiber);

          const finishedPhases = yield* Ref.get(reconcilePhases);
          assert.equal(
            finishedPhases.indexOf("selected-checks.reconcile:finished"),
            finishedPhases.length - 1,
          );
          assert.isTrue(yield* Deferred.isDone(commandReadyReceipt));
        }).pipe(Effect.provide(startupLayer));
      }),
    ),
  );
});

it.layer(NodeServices.layer)("project memory send startup reconciliation", (it) => {
  it.effect(
    "reconciles foreign pending rows before the first admitted command and preserves terminal rows",
    () => {
      const { tempDir, dbPath } = makeReconFileDbPath("t3-startup-recon-t1-");
      return Effect.scoped(
        Effect.gen(function* () {
          const persistence = makeSqlitePersistenceLive(dbPath);
          yield* seedPreviousOwnerRows(dbPath);
          const selectedChecksDeferreds = yield* makeNonBlockingSelectedChecksDeferreds;

          const memoryReconcileEntered = yield* Deferred.make<void>();
          const memoryReconcileRelease = yield* Deferred.make<void>();
          const m1StateInCommand = yield* Ref.make<string | null>(null);
          const commandBodyEntered = yield* Ref.make(false);
          const reconcilePhases = yield* Ref.make<ReadonlyArray<string>>([]);

          const memoryLayers = makeProductionShapedMemoryLayers(persistence, (service) => ({
            ...service,
            reconcileOtherOwners: (input) =>
              Effect.gen(function* () {
                yield* Deferred.succeed(memoryReconcileEntered, undefined);
                yield* Deferred.await(memoryReconcileRelease);
                return yield* service.reconcileOtherOwners(input);
              }),
          }));

          const startupLayer = buildStartupOrderingStartupLayer({
            reconcilePhases,
            selectedChecksReconcileEntered: selectedChecksDeferreds.entered,
            selectedChecksReconcileRelease: selectedChecksDeferreds.release,
            persistence,
            memoryLayers,
            serverConfigPath: dbPath,
            serverConfigPrefix: "t3-recon-t1-",
          });

          yield* Effect.gen(function* () {
            const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
            const gate = yield* ProjectMemorySendGate.ProjectMemorySendGate;
            const sql = yield* SqlClient.SqlClient;
            const commandFiber = yield* startup
              .enqueueCommand(
                Effect.gen(function* () {
                  yield* Ref.set(commandBodyEntered, true);
                  const rows = yield* reconAttemptRows;
                  const m1 = rows.find((row) => row.messageId === "message-m1");
                  yield* Ref.set(m1StateInCommand, m1?.state ?? null);
                }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
              )
              .pipe(Effect.forkScoped);

            yield* startup.markHttpListening;
            yield* Deferred.await(memoryReconcileEntered);

            const beforeRows = yield* reconAttemptRows;
            const m1Before = beforeRows.find((row) => row.messageId === "message-m1");
            assert.equal(m1Before?.state, "dispatch_committed");

            yield* seedReconMessage(STARTUP_RECON_THREAD_ID, "message-m4");
            const admitted = yield* gate.admit(reconCommitInput("message-m4"));
            if (admitted._tag !== "Committed") {
              return assert.fail("expected committed admission for message-m4");
            }
            assert.isFalse(yield* Ref.get(commandBodyEntered));

            yield* Deferred.succeed(memoryReconcileRelease, undefined);
            yield* startup.awaitCommandReady;
            yield* Fiber.join(commandFiber);

            assert.equal(yield* Ref.get(m1StateInCommand), "external_send_unknown");

            const finalRows = yield* reconAttemptRows;
            const m1 = finalRows.find((row) => row.messageId === "message-m1");
            const m2 = finalRows.find((row) => row.messageId === "message-m2");
            const m3 = finalRows.find((row) => row.messageId === "message-m3");
            const m4 = finalRows.find((row) => row.messageId === "message-m4");
            assert.equal(m1?.state, "external_send_unknown");
            assert.isNotNull(m1?.settledAt);
            assert.equal(m1?.ownerInstanceId, m1Before?.ownerInstanceId);
            assert.equal(m2?.state, "provider_accepted");
            assert.equal(m2?.settledAt, STARTUP_RECON_NOW_ISO);
            assert.equal(m3?.state, "external_send_unknown");
            assert.equal(m3?.settledAt, STARTUP_RECON_NOW_ISO);
            assert.equal(m4?.state, "dispatch_committed");
            yield* gate.settle(admitted.attemptSeq, "provider_accepted");
            const afterSettle = yield* reconAttemptRows;
            assert.equal(
              afterSettle.find((row) => row.messageId === "message-m4")?.state,
              "provider_accepted",
            );
          }).pipe(Effect.provide(startupLayer));
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("held already-committed after reconciliation does not duplicate rows", () => {
    const { tempDir, dbPath } = makeReconFileDbPath("t3-startup-recon-t2-");
    return Effect.scoped(
      Effect.gen(function* () {
        const persistence = makeSqlitePersistenceLive(dbPath);
        yield* seedPreviousOwnerRows(dbPath);
        const selectedChecksDeferreds = yield* makeNonBlockingSelectedChecksDeferreds;
        const reconcilePhases = yield* Ref.make<ReadonlyArray<string>>([]);

        const startupLayer = buildStartupOrderingStartupLayer({
          reconcilePhases,
          selectedChecksReconcileEntered: selectedChecksDeferreds.entered,
          selectedChecksReconcileRelease: selectedChecksDeferreds.release,
          persistence,
          memoryLayers: makeProductionShapedMemoryLayers(persistence),
          serverConfigPath: dbPath,
          serverConfigPrefix: "t3-recon-t2-",
        });

        yield* Effect.gen(function* () {
          const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
          const gate = yield* ProjectMemorySendGate.ProjectMemorySendGate;
          yield* startup.markHttpListening;
          yield* startup.awaitCommandReady;

          const held = yield* gate.admit(reconCommitInput("message-m1"));
          assert.deepEqual(held, { _tag: "Held", reason: "already-committed" });
          const rows = yield* reconAttemptRows;
          assert.equal(rows.filter((row) => row.messageId === "message-m1").length, 1);
          assert.equal(
            rows.find((row) => row.messageId === "message-m1")?.state,
            "external_send_unknown",
          );
          assert.equal(yield* reconItemCount, 3);
        }).pipe(Effect.provide(startupLayer));
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  it.effect(
    "typed persistence failure fails startup closed without activate or command entry",
    () => {
      const { tempDir, dbPath } = makeReconFileDbPath("t3-startup-recon-t3-sql-");
      return Effect.scoped(
        Effect.gen(function* () {
          const persistence = makeSqlitePersistenceLive(dbPath);
          const selectedChecksDeferreds = yield* makeNonBlockingSelectedChecksDeferreds;
          const reconcilePhases = yield* Ref.make<ReadonlyArray<string>>([]);
          const abortReceipt = yield* Deferred.make<void>();
          const activateEntered = yield* Ref.make(false);
          const commandBodyEntered = yield* Ref.make(false);
          const injectedReconcileError = new PersistenceSqlError({
            operation: "ProjectMemorySendLedger.reconcileOtherOwners",
            detail: "injected",
          });

          const startupLayer = buildStartupOrderingStartupLayer({
            reconcilePhases,
            selectedChecksReconcileEntered: selectedChecksDeferreds.entered,
            selectedChecksReconcileRelease: selectedChecksDeferreds.release,
            persistence,
            memoryLayers: makeProductionShapedMemoryLayers(persistence, (service) => ({
              ...service,
              reconcileOtherOwners: () => Effect.fail(injectedReconcileError),
            })),
            serverConfigPath: dbPath,
            startupOptions: {
              activate: Ref.set(activateEntered, true),
              awaitAuxiliaryParked: Effect.void,
              abort: () => Deferred.succeed(abortReceipt, undefined),
            },
          });

          yield* Effect.gen(function* () {
            const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
            const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
            const commandFiber = yield* startup
              .enqueueCommand(Ref.set(commandBodyEntered, true))
              .pipe(Effect.forkScoped);
            yield* startup.markHttpListening;

            const readinessExit = yield* Effect.exit(startup.awaitCommandReady);
            if (!Exit.isFailure(readinessExit)) {
              return assert.fail("expected readiness failure");
            }
            const error = Cause.squash(readinessExit.cause);
            if (!(error instanceof ServerRuntimeStartup.ServerRuntimeStartupError)) {
              return assert.fail("expected ServerRuntimeStartupError");
            }
            if (!Cause.isCause(error.cause)) {
              return assert.fail("expected stored Effect cause");
            }
            const storedFailure = Cause.squash(error.cause);
            assert.instanceOf(storedFailure, PersistenceSqlError);
            assert.equal(storedFailure.operation, injectedReconcileError.operation);
            assert.equal(storedFailure.detail, injectedReconcileError.detail);

            yield* Deferred.await(abortReceipt);
            const commandExit = yield* Fiber.await(commandFiber);
            assert.isTrue(Exit.isFailure(commandExit));
            assert.isFalse(yield* Ref.get(activateEntered));
            assert.isFalse(yield* Ref.get(commandBodyEntered));
            assert.isFalse(
              (yield* lifecycle.snapshot).events.some((event) => event.type === "ready"),
            );
          }).pipe(Effect.provide(startupLayer));
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
    },
  );

  it.effect("injected reconcile interrupt fails startup closed and retains interrupt cause", () => {
    const { tempDir, dbPath } = makeReconFileDbPath("t3-startup-recon-t3-int-");
    return Effect.scoped(
      Effect.gen(function* () {
        const persistence = makeSqlitePersistenceLive(dbPath);
        const selectedChecksDeferreds = yield* makeNonBlockingSelectedChecksDeferreds;
        const reconcilePhases = yield* Ref.make<ReadonlyArray<string>>([]);
        const abortReceipt = yield* Deferred.make<void>();
        const activateEntered = yield* Ref.make(false);
        const commandBodyEntered = yield* Ref.make(false);

        const startupLayer = buildStartupOrderingStartupLayer({
          reconcilePhases,
          selectedChecksReconcileEntered: selectedChecksDeferreds.entered,
          selectedChecksReconcileRelease: selectedChecksDeferreds.release,
          persistence,
          memoryLayers: makeProductionShapedMemoryLayers(persistence, (service) => ({
            ...service,
            reconcileOtherOwners: () => Effect.interrupt,
          })),
          serverConfigPath: dbPath,
          startupOptions: {
            activate: Ref.set(activateEntered, true),
            awaitAuxiliaryParked: Effect.void,
            abort: () => Deferred.succeed(abortReceipt, undefined),
          },
        });

        yield* Effect.gen(function* () {
          const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
          const lifecycle = yield* ServerLifecycleEvents.ServerLifecycleEvents;
          const commandFiber = yield* startup
            .enqueueCommand(Ref.set(commandBodyEntered, true))
            .pipe(Effect.forkScoped);
          yield* startup.markHttpListening;

          const readinessExit = yield* Effect.exit(startup.awaitCommandReady);
          if (!Exit.isFailure(readinessExit)) {
            return assert.fail("expected readiness failure");
          }
          const error = Cause.squash(readinessExit.cause);
          if (!(error instanceof ServerRuntimeStartup.ServerRuntimeStartupError)) {
            return assert.fail("expected ServerRuntimeStartupError");
          }
          if (!Cause.isCause(error.cause)) {
            return assert.fail("expected stored Effect cause");
          }
          assert.isTrue(Cause.hasInterrupts(error.cause));

          yield* Deferred.await(abortReceipt);
          const commandExit = yield* Fiber.await(commandFiber);
          assert.isTrue(Exit.isFailure(commandExit));
          assert.isFalse(yield* Ref.get(activateEntered));
          assert.isFalse(yield* Ref.get(commandBodyEntered));
          assert.isFalse(
            (yield* lifecycle.snapshot).events.some((event) => event.type === "ready"),
          );
        }).pipe(Effect.provide(startupLayer));
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });

  it.effect(
    "live sibling owner receives already-final when reconciling startup converts its pending row",
    () => {
      const { tempDir, dbPath } = makeReconFileDbPath("t3-startup-recon-t4-");
      return Effect.scoped(
        Effect.gen(function* () {
          const persistence = makeSqlitePersistenceLive(dbPath);
          const selectedChecksDeferreds = yield* makeNonBlockingSelectedChecksDeferreds;
          const reconcilePhases = yield* Ref.make<ReadonlyArray<string>>([]);
          const seedCommitted = yield* Deferred.make<void, unknown>();
          const startupReconciled = yield* Deferred.make<void>();
          const siblingSettleResult = yield* Ref.make<ProjectMemorySendSettleResult | null>(null);

          const siblingFiber = yield* Effect.forkScoped(
            runIsolatedLedger(
              dbPath,
              Effect.gen(function* () {
                const ledger = yield* ProjectMemorySendLedger;
                yield* seedReconProject(STARTUP_RECON_PROJECT_ID);
                yield* seedReconThread(STARTUP_RECON_PROJECT_ID, STARTUP_RECON_THREAD_ID);
                yield* seedReconMemory("mem-recon", STARTUP_RECON_PROJECT_ID);
                yield* seedReconMessage(STARTUP_RECON_THREAD_ID, "message-m1");
                const committed = yield* ledger.commitDispatch(reconCommitInput("message-m1"));
                if (committed.status !== "committed") {
                  yield* Deferred.failCause(seedCommitted, Cause.die("expected committed"));
                  return yield* Effect.die("expected committed");
                }
                yield* Deferred.succeed(seedCommitted, undefined);
                yield* Deferred.await(startupReconciled);
                const settled = yield* ledger.settle({
                  attemptSeq: committed.attemptSeq,
                  outcome: "provider_accepted",
                  now: STARTUP_RECON_NOW,
                });
                yield* Ref.set(siblingSettleResult, settled);
              }),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit) ? Deferred.failCause(seedCommitted, exit.cause) : Effect.void,
              ),
            ),
          );

          yield* Deferred.await(seedCommitted);

          const startupLayer = buildStartupOrderingStartupLayer({
            reconcilePhases,
            selectedChecksReconcileEntered: selectedChecksDeferreds.entered,
            selectedChecksReconcileRelease: selectedChecksDeferreds.release,
            persistence,
            memoryLayers: makeProductionShapedMemoryLayers(persistence),
            serverConfigPath: dbPath,
            serverConfigPrefix: "t3-recon-t4-",
          });

          yield* Effect.gen(function* () {
            const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
            yield* startup.markHttpListening;
            yield* startup.awaitCommandReady;

            const rows = yield* reconAttemptRows;
            assert.equal(
              rows.find((row) => row.messageId === "message-m1")?.state,
              "external_send_unknown",
            );

            yield* Deferred.succeed(startupReconciled, undefined);
          }).pipe(Effect.provide(startupLayer));

          const siblingExit = yield* Fiber.await(siblingFiber);
          assert.isTrue(Exit.isSuccess(siblingExit));

          const settled = yield* Ref.get(siblingSettleResult);
          assert.isNotNull(settled);
          assert.deepEqual(settled, {
            status: "already-final",
            state: "external_send_unknown",
          });
        }),
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true })),
        ),
      );
    },
  );
});
