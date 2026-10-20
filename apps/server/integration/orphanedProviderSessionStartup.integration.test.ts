import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { HttpServer } from "effect/unstable/http";
import * as NetAddress from "effect/unstable/net/NetAddress";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServiceLauncherClient from "../src/cloud/serviceLauncherClient.ts";
import * as ServerConfig from "../src/config.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as Keybindings from "../src/keybindings.ts";
import { OrchestrationCommandInvariantError } from "../src/orchestration/Errors.ts";
import { OrchestrationLayerLive } from "../src/orchestration/runtimeLayer.ts";
import * as OrchestrationEngine from "../src/orchestration/Services/OrchestrationEngine.ts";
import * as OrchestrationReactor from "../src/orchestration/Services/OrchestrationReactor.ts";
import * as ProjectionSnapshotQuery from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../src/persistence/ProviderSessionRuntime.ts";
import * as ProviderSafetyObservations from "../src/persistence/ProviderSafetyObservations.ts";
import { PersistenceSqlError } from "../src/persistence/Errors.ts";
import * as ExternalLauncher from "../src/process/externalLauncher.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderService from "../src/provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../src/provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "../src/provider/Services/ProviderSessionReaper.ts";
import * as RepositoryIdentityResolver from "../src/project/RepositoryIdentityResolver.ts";
import { layer as restartContinuationsLayer } from "../src/restartContinuations.ts";
import * as ProjectMemorySendGate from "../src/memory/ProjectMemorySendGate.ts";
import * as ReleaseVerification from "../src/releaseVerification/ReleaseVerification.ts";
import { layer as ProjectMemorySendLedgerLayer } from "../src/persistence/ProjectMemorySendLedger.ts";
import * as SelectedChecks from "../src/selectedChecks/SelectedChecks.ts";
import * as ServerLifecycleEvents from "../src/serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../src/serverRuntimeStartup.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import * as AnalyticsService from "../src/telemetry/AnalyticsService.ts";
import * as GitVcsDriver from "../src/vcs/GitVcsDriver.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project-startup-orphan");
const threadId = ThreadId.make("thread-startup-orphan");
const stoppedBindingThreadId = ThreadId.make("thread-startup-orphan-stopped-binding");
const resumeCursor = { schemaVersion: 1, sessionId: "provider-session-before-restart" };
const stoppedBindingResumeCursor = {
  schemaVersion: 1,
  sessionId: "provider-session-stopped-before-restart",
};

const makePersistedRuntimeLayer = (dbPath: string) => {
  const persistence = makeSqlitePersistenceLive(dbPath);
  const orchestration = OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(persistence),
  );
  const directory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntime.layer),
    Layer.provide(persistence),
  );
  return Layer.mergeAll(
    orchestration,
    directory,
    ProviderSafetyObservations.layer.pipe(Layer.provide(persistence)),
    ProjectMemorySendLedgerLayer.pipe(Layer.provide(persistence)),
    // Startup needs the gate present; these cases never consult its driver allowlist, so the
    // empty default policy stands in for ProjectMemorySendPolicyLive.
    ProjectMemorySendGate.layer.pipe(Layer.provide(persistence)),
  ).pipe(Layer.provideMerge(restartContinuationsLayer));
};

const startupDependencies = Layer.mergeAll(
  Layer.mock(Keybindings.Keybindings)({
    start: Effect.void,
  }),
  ServerSettings.layerTest(),
  Layer.succeed(OrchestrationReactor.OrchestrationReactor, {
    start: () => Effect.void,
  }),
  Layer.succeed(ProviderSessionReaper.ProviderSessionReaper, {
    start: () => Effect.void,
  }),
  // Startup settles old verification records; this test is about provider sessions only.
  Layer.mock(ReleaseVerification.ReleaseVerification)({
    reconcile: Effect.void,
  }),
  // Selected-check reconciliation runs at startup; these cases cover provider sessions only.
  Layer.mock(SelectedChecks.SelectedChecks)({
    reconcile: Effect.void,
  }),
  ServerLifecycleEvents.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-startup-orphan")),
    getDescriptor: Effect.succeed({
      environmentId: EnvironmentId.make("environment-startup-orphan"),
      label: "Startup orphan test",
      version: "test",
      platform: { os: "linux", arch: "x64" },
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
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    previewSubmissionRoute: () => Effect.die("unused"),
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
);

it.effect(
  "recovers a persisted starting session before opening the command gate after restart",
  () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const firstRuntime = makePersistedRuntimeLayer(config.dbPath);
      const now = yield* DateTime.now;
      const createdAt = DateTime.formatIso(now);

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("command-create-project"),
          projectId,
          title: "Startup orphan project",
          workspaceRoot: "/tmp/startup-orphan-project",
          defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command-create-thread"),
          threadId,
          projectId,
          title: "Startup orphan thread",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-pending-turn"),
          threadId,
          message: {
            messageId: MessageId.make("message-pending-before-restart"),
            role: "user",
            text: "Persist this queued turn before restart",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("command-mark-session-starting"),
          threadId,
          session: {
            threadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* directory.upsert({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "running",
          resumeCursor,
          runtimePayload: { activeTurnId: null, unrelated: "preserve-me" },
          runtimeMode: "full-access",
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("command-create-stopped-binding-thread"),
          threadId: stoppedBindingThreadId,
          projectId,
          title: "Startup orphan with stopped binding",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("command-start-stopped-binding-pending-turn"),
          threadId: stoppedBindingThreadId,
          message: {
            messageId: MessageId.make("message-stopped-binding-pending-before-restart"),
            role: "user",
            text: "Persist another queued turn before restart",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("command-mark-stopped-binding-session-starting"),
          threadId: stoppedBindingThreadId,
          session: {
            threadId: stoppedBindingThreadId,
            status: "starting",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* directory.upsert({
          threadId: stoppedBindingThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "stopped",
          resumeCursor: stoppedBindingResumeCursor,
          runtimePayload: { activeTurnId: "stale", unrelated: "also-preserve-me" },
          runtimeMode: "full-access",
        });
      }).pipe(Effect.provide(firstRuntime));

      const secondRuntime = makePersistedRuntimeLayer(config.dbPath);
      const startupLayer = ServerRuntimeStartup.layer.pipe(
        Layer.provideMerge(secondRuntime),
        Layer.provideMerge(startupDependencies),
      );

      const result = yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;

        yield* startup.markHttpListening;
        yield* startup.awaitCommandReady;

        const restartedThread = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        const restartedStoppedBindingThread = Option.getOrThrow(
          yield* query.getThreadDetailById(stoppedBindingThreadId),
        );
        const pendingRows = yield* sql<{ readonly threadId: string }>`
          SELECT thread_id AS "threadId"
          FROM projection_turns
          WHERE thread_id IN (${threadId}, ${stoppedBindingThreadId})
            AND turn_id IS NULL
            AND state = 'pending'
        `;
        const settleExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command-settle-after-restart"),
            threadId,
          }),
        );
        const snoozeExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.snooze",
            commandId: CommandId.make("command-snooze-after-restart"),
            threadId,
            snoozedUntil: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
          }),
        );
        const newTurnExit = yield* Effect.exit(
          engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make("command-new-turn-after-restart"),
            threadId,
            message: {
              messageId: MessageId.make("message-new-turn-after-restart"),
              role: "user",
              text: "Continue immediately after restart",
              attachments: [],
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            createdAt,
          }),
        );
        const binding = Option.getOrThrow(yield* directory.getBinding(threadId));
        const stoppedBinding = Option.getOrThrow(
          yield* directory.getBinding(stoppedBindingThreadId),
        );

        return {
          sessionStatus: restartedThread.session?.status,
          activeTurnId: restartedThread.session?.activeTurnId,
          latestTurn: restartedThread.latestTurn,
          pendingTurnCount: pendingRows.length,
          settleSucceeded: Exit.isSuccess(settleExit),
          snoozeSucceeded: Exit.isSuccess(snoozeExit),
          newTurnSucceeded: Exit.isSuccess(newTurnExit),
          bindingStatus: binding.status,
          resumeCursor: binding.resumeCursor,
          runtimePayload: binding.runtimePayload,
          stoppedBindingSessionStatus: restartedStoppedBindingThread.session?.status,
          stoppedBindingStatus: stoppedBinding.status,
          stoppedBindingResumeCursor: stoppedBinding.resumeCursor,
          stoppedBindingRuntimePayload: stoppedBinding.runtimePayload,
        };
      }).pipe(Effect.provide(startupLayer));

      assert.deepStrictEqual(result, {
        sessionStatus: "error",
        activeTurnId: null,
        latestTurn: null,
        pendingTurnCount: 0,
        settleSucceeded: true,
        snoozeSucceeded: true,
        newTurnSucceeded: true,
        bindingStatus: "stopped",
        resumeCursor,
        runtimePayload: { activeTurnId: null, unrelated: "preserve-me" },
        stoppedBindingSessionStatus: "error",
        stoppedBindingStatus: "stopped",
        stoppedBindingResumeCursor,
        stoppedBindingRuntimePayload: {
          activeTurnId: null,
          unrelated: "also-preserve-me",
        },
      });
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-orphaned-provider-session-startup-",
        }).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    ),
);

it.effect.each(["opt-in desktop restart", "marked remote update"] as const)(
  "continues a newer persisted turn after %s",
  (restart) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const activeTurnId = TurnId.make("turn-started-after-original-send");
      const originalTurnId = TurnId.make("turn-from-original-send");
      const sent = yield* Deferred.make<ProviderSendTurnInput>();

      yield* Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("create-restart-project"),
          projectId,
          title: "Restart continuation",
          workspaceRoot: "/tmp/startup-orphan-project",
          defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-restart-thread"),
          threadId,
          projectId,
          title: "Newer running turn",
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        yield* engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("persist-newer-running-turn"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            providerInstanceId,
            runtimeMode: "full-access",
            activeTurnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        yield* directory.upsert({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId,
          status: "running",
          resumeCursor,
          runtimePayload: { activeTurnId: originalTurnId },
        });
        if (restart === "marked remote update") {
          assert.deepStrictEqual(
            yield* ServerRuntimeStartup.markRunningProviderSessionsForContinuation,
            [threadId],
          );
        }
      }).pipe(Effect.provide(makePersistedRuntimeLayer(config.dbPath)));

      yield* Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const provider = yield* ProviderService.ProviderService;
        const before = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        assert.equal(before.session?.activeTurnId, activeTurnId);
        assert.propertyVal(
          Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload,
          "activeTurnId",
          originalTurnId,
        );
        yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
          Effect.provideService(ProviderService.ProviderService, {
            ...provider,
            getCapabilities: () =>
              Effect.succeed({
                sessionModelSwitch: "in-session",
                promptlessTurnContinuation: true,
              }),
            sendTurn: (input) =>
              Deferred.succeed(sent, input).pipe(
                Effect.as({ threadId, turnId: TurnId.make("continued-turn") }),
              ),
          }),
          Effect.provide(
            ServerSettings.layerTest({
              continueThreadsAfterServerUpdate: restart === "opt-in desktop restart",
            }),
          ),
        );
        const after = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
        assert.equal(after.session?.status, "starting");
        assert.equal(after.session?.activeTurnId, null);
        assert.equal(after.session?.lastError, null);
        assert.deepStrictEqual(yield* Deferred.await(sent), {
          threadId,
          continuation: true,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        });
      }).pipe(
        Effect.provide(
          Layer.mergeAll(makePersistedRuntimeLayer(config.dbPath), startupDependencies),
        ),
      );
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-restart-newer-turn-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
const SAVED_ANSWER_ERROR =
  "Part of the assistant's response could not be saved, so the answer shown may be incomplete.";
const KEPT_SESSION_ERROR = "Provider failure reported before the restart.";
const savedErrorThreadId = ThreadId.make("thread-startup-saved-error");
const settledErrorThreadId = ThreadId.make("thread-startup-settled-error");
const blockedTurnId = TurnId.make("turn-blocked-by-failed-recovery");
const savedErrorTurnId = TurnId.make("turn-saved-error-orphan");
const inspectionTurnId = TurnId.make("turn-inspection-failure");

const turnStartCommand = (input: {
  readonly commandId: string;
  readonly messageId: string;
  readonly text: string;
  readonly createdAt: string;
}) =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make(input.commandId),
    threadId,
    message: {
      messageId: MessageId.make(input.messageId),
      role: "user",
      text: input.text,
      attachments: [],
    },
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    runtimeMode: "full-access",
    createdAt: input.createdAt,
  }) as const;

const recordProviderSends = (sent: ProviderSendTurnInput[]) =>
  Layer.effect(
    ProviderService.ProviderService,
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      return ProviderService.ProviderService.of({
        ...provider,
        sendTurn: (input) =>
          Effect.sync(() => {
            sent.push(input);
          }).pipe(Effect.andThen(provider.sendTurn(input))),
      });
    }),
  );

const seedRunningOrphan = (input: { readonly turnId: TurnId; readonly createdAt: string }) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`create-blocked-project-${input.turnId}`),
      projectId,
      title: "Blocked recovery project",
      workspaceRoot: "/tmp/startup-orphan-project",
      defaultModelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      createdAt: input.createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-blocked-thread-${input.turnId}`),
      threadId,
      projectId,
      title: "Blocked recovery thread",
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: input.createdAt,
    });
    yield* engine.dispatch({
      type: "thread.session.set",
      commandId: CommandId.make(`mark-blocked-running-${input.turnId}`),
      threadId,
      session: {
        threadId,
        status: "running",
        providerName: "codex",
        providerInstanceId,
        runtimeMode: "full-access",
        activeTurnId: input.turnId,
        lastError: null,
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
    yield* directory.upsert({
      threadId,
      provider: ProviderDriverKind.make("codex"),
      providerInstanceId,
      status: "running",
      resumeCursor,
      runtimePayload: { activeTurnId: input.turnId },
      runtimeMode: "full-access",
    });
  });

it.effect("refuses commands until a failed recovery write is committed by a later restart", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    yield* Effect.gen(function* () {
      yield* seedRunningOrphan({ turnId: blockedTurnId, createdAt });
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-saved-error-thread"),
        threadId: savedErrorThreadId,
        projectId,
        title: "Saved error thread",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("mark-saved-error-session"),
        threadId: savedErrorThreadId,
        session: {
          threadId: savedErrorThreadId,
          status: "error",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: savedErrorTurnId,
          lastError: SAVED_ANSWER_ERROR,
          updatedAt: createdAt,
        },
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-settled-error-thread"),
        threadId: settledErrorThreadId,
        projectId,
        title: "Settled error thread",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("mark-settled-error-session"),
        threadId: settledErrorThreadId,
        session: {
          threadId: settledErrorThreadId,
          status: "error",
          providerName: "codex",
          providerInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: KEPT_SESSION_ERROR,
          updatedAt: createdAt,
        },
        createdAt,
      });
    }).pipe(Effect.provide(makePersistedRuntimeLayer(config.dbPath)));

    const secondRuntime = makePersistedRuntimeLayer(config.dbPath);
    let settleWriteAttempts = 0;
    const failingSettleLayer = Layer.effect(
      OrchestrationEngine.OrchestrationEngineService,
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        return OrchestrationEngine.OrchestrationEngineService.of({
          ...engine,
          dispatch: (command, options) => {
            if (command.type === "thread.session.set" && command.session.status === "error") {
              settleWriteAttempts += 1;
              return Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: "thread.session.set",
                  detail: "injected startup recovery settlement failure",
                }),
              );
            }
            return engine.dispatch(command, options);
          },
        });
      }),
    );

    const sent: ProviderSendTurnInput[] = [];
    const blocked = yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* startup.markHttpListening;
      const readyExit = yield* Effect.exit(startup.awaitCommandReady);
      const turnExit = yield* Effect.exit(
        startup.enqueueCommand(
          engine.dispatch(
            turnStartCommand({
              commandId: "command-blocked-turn",
              messageId: "message-blocked-turn",
              text: "This turn must be refused while recovery is unwritten",
              createdAt,
            }),
          ),
        ),
      );
      const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      const savedDetail = Option.getOrThrow(yield* query.getThreadDetailById(savedErrorThreadId));
      const turnRows = yield* sql<{
        readonly turnId: string | null;
        readonly state: string;
      }>`
          SELECT turn_id AS "turnId", state FROM projection_turns
          WHERE thread_id = ${threadId} ORDER BY turn_id
        `;
      return {
        readyExit,
        turnExit,
        sessionStatus: detail.session?.status,
        activeTurnId: detail.session?.activeTurnId,
        latestTurn: detail.latestTurn,
        savedLastError: savedDetail.session?.lastError,
        savedActiveTurnId: savedDetail.session?.activeTurnId,
        turnRows,
      };
    }).pipe(
      Effect.provide(
        ServerRuntimeStartup.layer.pipe(
          Layer.provideMerge(failingSettleLayer),
          Layer.provideMerge(recordProviderSends(sent)),
          Layer.provideMerge(secondRuntime),
          Layer.provideMerge(startupDependencies),
        ),
      ),
    );

    assert.isTrue(Exit.isFailure(blocked.readyExit));
    if (Exit.isFailure(blocked.readyExit)) {
      assert.isTrue(
        Cause.squash(blocked.readyExit.cause) instanceof
          ServerRuntimeStartup.ServerRuntimeStartupError,
      );
    }
    assert.isTrue(Exit.isFailure(blocked.turnExit));
    assert.equal(settleWriteAttempts, 4);
    assert.deepStrictEqual(sent, []);
    assert.equal(blocked.sessionStatus, "running");
    assert.equal(blocked.activeTurnId, blockedTurnId);
    assert.equal(blocked.latestTurn?.turnId, blockedTurnId);
    assert.equal(blocked.latestTurn?.state, "running");
    assert.equal(blocked.savedLastError, SAVED_ANSWER_ERROR);
    assert.equal(blocked.savedActiveTurnId, savedErrorTurnId);
    assert.deepStrictEqual(blocked.turnRows, [{ turnId: blockedTurnId, state: "running" }]);

    const thirdRuntime = makePersistedRuntimeLayer(config.dbPath);
    const recovered = yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* startup.markHttpListening;
      yield* startup.awaitCommandReady;
      const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      const savedDetail = Option.getOrThrow(yield* query.getThreadDetailById(savedErrorThreadId));
      const settledDetail = Option.getOrThrow(
        yield* query.getThreadDetailById(settledErrorThreadId),
      );
      const turnExit = yield* Effect.exit(
        startup.enqueueCommand(
          engine.dispatch(
            turnStartCommand({
              commandId: "command-accepted-turn",
              messageId: "message-accepted-turn",
              text: "Send the user's next turn after recovery committed",
              createdAt,
            }),
          ),
        ),
      );
      const turnRows = yield* sql<{ readonly state: string }>`
          SELECT state FROM projection_turns WHERE turn_id = ${blockedTurnId}
        `;
      return {
        turnExit,
        sessionStatus: detail.session?.status,
        sessionLastError: detail.session?.lastError,
        activeTurnId: detail.session?.activeTurnId,
        latestTurnState: detail.latestTurn?.state,
        savedStatus: savedDetail.session?.status,
        savedLastError: savedDetail.session?.lastError,
        savedActiveTurnId: savedDetail.session?.activeTurnId,
        settledStatus: settledDetail.session?.status,
        settledLastError: settledDetail.session?.lastError,
        settledUpdatedAt: settledDetail.session?.updatedAt,
        turnRows,
      };
    }).pipe(
      Effect.provide(
        ServerRuntimeStartup.layer.pipe(
          Layer.provideMerge(thirdRuntime),
          Layer.provideMerge(startupDependencies),
        ),
      ),
    );

    assert.isTrue(Exit.isSuccess(recovered.turnExit));
    assert.equal(recovered.sessionStatus, "error");
    assert.equal(recovered.sessionLastError, ORPHANED_PROVIDER_SESSION_ERROR);
    assert.equal(recovered.activeTurnId, null);
    assert.equal(recovered.latestTurnState, "error");
    assert.equal(recovered.savedStatus, "error");
    assert.equal(recovered.savedLastError, SAVED_ANSWER_ERROR);
    assert.equal(recovered.savedActiveTurnId, null);
    assert.equal(recovered.settledStatus, "error");
    assert.equal(recovered.settledLastError, KEPT_SESSION_ERROR);
    assert.equal(recovered.settledUpdatedAt, createdAt);
    assert.deepStrictEqual(recovered.turnRows, [{ state: "error" }]);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-recovery-gate-settle-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);

it.effect("refuses commands when recovery inspection cannot read the projection", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    yield* seedRunningOrphan({ turnId: inspectionTurnId, createdAt }).pipe(
      Effect.provide(makePersistedRuntimeLayer(config.dbPath)),
    );

    const secondRuntime = makePersistedRuntimeLayer(config.dbPath);
    let inspectionReads = 0;
    const failingInspectionLayer = Layer.effect(
      ProjectionSnapshotQuery.ProjectionSnapshotQuery,
      Effect.gen(function* () {
        const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        return ProjectionSnapshotQuery.ProjectionSnapshotQuery.of({
          ...query,
          getCommandReadModel: () => {
            inspectionReads += 1;
            return Effect.fail(
              new PersistenceSqlError({
                operation: "ProjectionSnapshotQuery.getCommandReadModel",
                detail: "injected recovery inspection failure",
              }),
            );
          },
        });
      }),
    );

    const sent: ProviderSendTurnInput[] = [];
    const blocked = yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* startup.markHttpListening;
      const readyExit = yield* Effect.exit(startup.awaitCommandReady);
      const turnExit = yield* Effect.exit(
        startup.enqueueCommand(
          engine.dispatch(
            turnStartCommand({
              commandId: "command-inspection-blocked-turn",
              messageId: "message-inspection-blocked-turn",
              text: "This turn must be refused while recovery cannot be inspected",
              createdAt,
            }),
          ),
        ),
      );
      const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      const turnRows = yield* sql<{ readonly turnId: string | null; readonly state: string }>`
        SELECT turn_id AS "turnId", state FROM projection_turns
        WHERE thread_id = ${threadId} ORDER BY turn_id
      `;
      return {
        readyExit,
        turnExit,
        sessionStatus: detail.session?.status,
        latestTurn: detail.latestTurn,
        turnRows,
      };
    }).pipe(
      Effect.provide(
        ServerRuntimeStartup.layer.pipe(
          Layer.provideMerge(failingInspectionLayer),
          Layer.provideMerge(recordProviderSends(sent)),
          Layer.provideMerge(secondRuntime),
          Layer.provideMerge(startupDependencies),
        ),
      ),
    );

    assert.isTrue(Exit.isFailure(blocked.readyExit));
    assert.isTrue(Exit.isFailure(blocked.turnExit));
    assert.equal(inspectionReads, 1);
    assert.deepStrictEqual(sent, []);
    assert.equal(blocked.sessionStatus, "running");
    assert.equal(blocked.latestTurn?.turnId, inspectionTurnId);
    assert.equal(blocked.latestTurn?.state, "running");
    assert.deepStrictEqual(blocked.turnRows, [{ turnId: inspectionTurnId, state: "running" }]);

    const thirdRuntime = makePersistedRuntimeLayer(config.dbPath);
    const recovered = yield* Effect.gen(function* () {
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* startup.markHttpListening;
      yield* startup.awaitCommandReady;
      const detail = Option.getOrThrow(yield* query.getThreadDetailById(threadId));
      const turnExit = yield* Effect.exit(
        startup.enqueueCommand(
          engine.dispatch(
            turnStartCommand({
              commandId: "command-inspection-accepted-turn",
              messageId: "message-inspection-accepted-turn",
              text: "Send the user's next turn after inspection recovered",
              createdAt,
            }),
          ),
        ),
      );
      const turnRows = yield* sql<{ readonly state: string }>`
        SELECT state FROM projection_turns WHERE turn_id = ${inspectionTurnId}
      `;
      return {
        turnExit,
        sessionStatus: detail.session?.status,
        sessionLastError: detail.session?.lastError,
        turnRows,
      };
    }).pipe(
      Effect.provide(
        ServerRuntimeStartup.layer.pipe(
          Layer.provideMerge(thirdRuntime),
          Layer.provideMerge(startupDependencies),
        ),
      ),
    );

    assert.isTrue(Exit.isSuccess(recovered.turnExit));
    assert.equal(recovered.sessionStatus, "error");
    assert.equal(recovered.sessionLastError, ORPHANED_PROVIDER_SESSION_ERROR);
    assert.deepStrictEqual(recovered.turnRows, [{ state: "error" }]);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-recovery-gate-inspect-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
