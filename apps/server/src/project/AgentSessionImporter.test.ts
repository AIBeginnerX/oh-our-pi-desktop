import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  AgentSessionImportProjectChangedError,
  AgentSessionScanError,
  CommandId,
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ProviderSendTurnInput,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeTestProviderAdapterHarness } from "../../integration/TestProviderAdapter.integration.ts";
import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  layer as projectMemoriesLayer,
  ProjectMemoryRepository,
} from "../persistence/ProjectMemories.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as ProviderSafetyObservations from "../persistence/ProviderSafetyObservations.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { layerUnavailable as projectMemorySendGateLayerUnavailable } from "../memory/ProjectMemorySendGate.ts";
import {
  RestartContinuations,
  layer as restartContinuationsLayer,
} from "../restartContinuations.ts";
import { ProviderCommandReactorLive } from "../orchestration/Layers/ProviderCommandReactor.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderCommandReactor } from "../orchestration/Services/ProviderCommandReactor.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../provider/Layers/ProviderService.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../provider/Layers/ProviderEventLoggers.ts";
import { ProviderSessionDirectoryPersistenceError } from "../provider/Errors.ts";
import { ProviderAdapterRegistry } from "../provider/Services/ProviderAdapterRegistry.ts";
import { ProviderAuthService } from "../provider/Services/ProviderAuthService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { makeAdapterRegistryMock } from "../provider/testUtils/providerAdapterRegistryMock.ts";
import { makeProviderRegistryLayer } from "../provider/testUtils/providerRegistryMock.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

const PROJECT_ID = ProjectId.make("project-1");
const WORKSPACE_ROOT = "/tmp/project-from-server";
const CLAUDE_SESSION_ID = "123e4567-e89b-42d3-a456-426614174000";
const encodeTranscriptRecord = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const makeThread = (source: "codex" | "claudeAgent"): AgentSessionScanner.AgentSessionThread => ({
  source,
  providerInstanceId: ProviderInstanceId.make(source),
  providerSessionId: source === "codex" ? "codex-session" : CLAUDE_SESSION_ID,
  title: `Imported ${source} thread`,
  model: null,
  createdAt: "2026-08-24T10:00:00.000Z",
  updatedAt: "2026-08-24T10:01:00.000Z",
  messages: [
    { role: "user", text: "Fix the bug", createdAt: "2026-08-24T10:00:00.000Z" },
    { role: "assistant", text: "Fixed", createdAt: "2026-08-24T10:01:00.000Z" },
  ],
});

const makeThreadOutcome = (thread: AgentSessionScanner.AgentSessionThread) =>
  ({
    _tag: "Importable",
    thread,
    source: {
      provider: thread.source,
      providerInstanceId: thread.providerInstanceId,
      providerSessionId: thread.providerSessionId,
      filePath: `/tmp/transcripts/${thread.providerInstanceId}/${thread.providerSessionId}.jsonl`,
      size: 0,
      mtimeMs: 0,
      device: 0,
      inode: 0,
      birthtimeMs: 0,
    },
  }) satisfies AgentSessionScanner.AgentSessionRecentThread;

const makeProject = (): OrchestrationProjectShell => ({
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: WORKSPACE_ROOT,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-24T09:00:00.000Z",
  updatedAt: "2026-08-24T09:00:00.000Z",
});

const makeProjectedThread = (input: {
  readonly source: "codex" | "claudeAgent";
  readonly projectId?: ProjectId;
  readonly imported?: boolean;
  readonly includeFollowup?: boolean;
}): OrchestrationThread => {
  const sourceThread = makeThread(input.source);
  const threadId = ThreadId.make(
    `import:${sourceThread.providerInstanceId}:${sourceThread.providerSessionId}`,
  );
  return {
    id: threadId,
    projectId: input.projectId ?? PROJECT_ID,
    title: sourceThread.title,
    modelSelection: { instanceId: sourceThread.providerInstanceId, model: "default" },
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: sourceThread.createdAt,
    updatedAt: sourceThread.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: input.imported
      ? [
          {
            id: MessageId.make(`${threadId}:000000`),
            role: "user",
            text: "Fix the bug",
            turnId: null,
            streaming: false,
            createdAt: "2026-08-24T10:00:00.000Z",
            updatedAt: "2026-08-24T10:00:00.000Z",
          },
          ...(input.includeFollowup
            ? [
                {
                  id: MessageId.make("user-followup"),
                  role: "user" as const,
                  text: "Keep going",
                  turnId: null,
                  streaming: false,
                  createdAt: "2026-08-24T10:02:00.000Z",
                  updatedAt: "2026-08-24T10:02:00.000Z",
                },
              ]
            : []),
        ]
      : [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
};

const makeSnapshotsLayer = (input: {
  readonly project?: OrchestrationProjectShell;
  readonly getThread?: (threadId: ThreadId) => Option.Option<OrchestrationThread>;
}) =>
  Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getProjectShellById: () =>
      Effect.succeed(input.project === undefined ? Option.none() : Option.some(input.project)),
    getImportedAgentSessionSources: () => Effect.succeed([]),
    getThreadDetailById: (threadId) => Effect.succeed(input.getThread?.(threadId) ?? Option.none()),
  });

const runImport = (input: {
  readonly scanner: AgentSessionScanner.AgentSessionScanner["Service"];
  readonly engine: OrchestrationEngine.OrchestrationEngineService["Service"];
  readonly directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  readonly snapshots: ReturnType<typeof makeSnapshotsLayer>;
  readonly expectedWorkspaceRoot?: string;
}) =>
  importRecentAgentThreads({
    projectId: PROJECT_ID,
    ...(input.expectedWorkspaceRoot === undefined
      ? {}
      : { expectedWorkspaceRoot: input.expectedWorkspaceRoot }),
  }).pipe(
    Effect.provideService(AgentSessionScanner.AgentSessionScanner, input.scanner),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, input.engine),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, input.directory),
    Effect.provide(input.snapshots),
  );

it.layer(NodeServices.layer)("AgentSessionImporter", (it) => {
  describe("importRecentAgentThreads", () => {
    it.effect("uses the project root and stores provider-specific resume cursors", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
        let scannedRoot: string | undefined;
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: (workspaceRoot) => {
            scannedRoot = workspaceRoot;
            return Stream.concat(
              Stream.succeed(makeThreadOutcome(makeThread("codex"))),
              Stream.fromEffect(
                Effect.sync(() => {
                  expect(bindings).toHaveLength(1);
                  return makeThreadOutcome(makeThread("claudeAgent"));
                }),
              ),
            );
          },
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: (binding) => Effect.sync(() => void bindings.push(binding)),
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.void,
          getBinding: () => Effect.succeedNone,
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        });

        const result = yield* runImport({
          scanner,
          engine,
          directory,
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
          expectedWorkspaceRoot: `${WORKSPACE_ROOT}/`,
        });

        expect(result).toEqual({ importedCount: 2, skippedCount: 0 });
        expect(scannedRoot).toBe(WORKSPACE_ROOT);
        expect(commands.map((command) => command.type)).toEqual([
          "thread.create",
          "thread.history.import",
          "thread.create",
          "thread.history.import",
        ]);
        expect(commands.filter((command) => command.type === "thread.create")).toMatchObject([
          { historyImport: true },
          { historyImport: true },
        ]);
        expect(
          commands
            .filter((command) => command.type === "thread.history.import")
            .flatMap((command) => command.messages.map((message) => message.messageId)),
        ).toEqual([
          "import:codex:codex-session:000000",
          "import:codex:codex-session:000001",
          `import:claudeAgent:${CLAUDE_SESSION_ID}:000000`,
          `import:claudeAgent:${CLAUDE_SESSION_ID}:000001`,
        ]);
        expect(bindings).toMatchObject([
          {
            provider: "codex",
            providerInstanceId: "codex",
            resumeCursor: { threadId: "codex-session" },
            runtimePayload: { cwd: WORKSPACE_ROOT },
          },
          {
            provider: "claudeAgent",
            providerInstanceId: "claudeAgent",
            resumeCursor: {
              threadId: `import:claudeAgent:${CLAUDE_SESSION_ID}`,
              resume: CLAUDE_SESSION_ID,
            },
            runtimePayload: { cwd: WORKSPACE_ROOT },
          },
        ]);
      }),
    );

    it.effect("rejects a changed project root before scanning or writing", () =>
      Effect.gen(function* () {
        const recentThreads = vi.fn(() => Stream.empty);
        const error = yield* importRecentAgentThreads({
          projectId: PROJECT_ID,
          expectedWorkspaceRoot: WORKSPACE_ROOT,
        }).pipe(
          Effect.provideService(
            AgentSessionScanner.AgentSessionScanner,
            AgentSessionScanner.AgentSessionScanner.of({
              scan: Effect.die("must not scan a changed project"),
              recentThreads,
            }),
          ),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(OrchestrationEngine.OrchestrationEngineService)({}),
              Layer.mock(ProviderSessionDirectory.ProviderSessionDirectory)({}),
              makeSnapshotsLayer({
                project: { ...makeProject(), workspaceRoot: "/tmp/project-moved" },
              }),
            ),
          ),
          Effect.flip,
        );

        expect(error).toEqual(new AgentSessionImportProjectChangedError({ projectId: PROJECT_ID }));
        expect(recentThreads).not.toHaveBeenCalled();
      }),
    );

    it.effect("counts scanner skips without writing a thread or binding", () =>
      Effect.gen(function* () {
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Stream.succeed({ _tag: "Skipped" }),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: () => Effect.die("must not dispatch for a scanner skip"),
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: () => Effect.die("must not bind a scanner skip"),
          upsertIf: () => Effect.die("must not bind a scanner skip"),
          upsertIfCurrent: () => Effect.die("must not bind a scanner skip"),
          getProvider: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getBinding: () => Effect.die("must not read a scanner skip binding"),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        });

        const result = yield* runImport({
          scanner,
          engine,
          directory,
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        });

        expect(result).toEqual({ importedCount: 0, skippedCount: 1 });
      }),
    );

    it.effect("recovers after a rejected history receipt and a failed binding write", () =>
      Effect.gen(function* () {
        let threadCreated = false;
        let historyImported = false;
        let historyAttemptCount = 0;
        let bindingAttemptCount = 0;
        const rejectedCommandIds = new Set<string>();
        const bindings: Array<ProviderSessionDirectory.ProviderRuntimeBinding> = [];
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Stream.fromIterable([makeThreadOutcome(makeThread("codex"))]),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => {
            if (rejectedCommandIds.has(command.commandId)) {
              return Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Previously rejected.",
                }),
              );
            }
            if (command.type === "thread.create") threadCreated = true;
            if (command.type === "thread.history.import") {
              historyAttemptCount += 1;
              if (historyAttemptCount === 1) {
                rejectedCommandIds.add(command.commandId);
                return Effect.fail(
                  new OrchestrationCommandInvariantError({
                    commandType: command.type,
                    detail: "Temporary history import failure.",
                  }),
                );
              }
              historyImported = true;
            }
            return Effect.succeed({ sequence: 1 });
          },
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: (binding) => {
            bindingAttemptCount += 1;
            if (bindingAttemptCount === 1) {
              return Effect.fail(
                new ProviderSessionDirectoryPersistenceError({
                  operation: "upsert",
                  detail: "Temporary session storage failure.",
                }),
              );
            }
            bindings.push(binding);
            return Effect.void;
          },
          upsertIf: () => Effect.die("unused"),
          upsertIfCurrent: () => Effect.die("unused"),
          getProvider: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.void,
          getBinding: () =>
            Effect.succeed(bindings[0] === undefined ? Option.none() : Option.some(bindings[0])),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        });
        const snapshots = makeSnapshotsLayer({
          project: makeProject(),
          getThread: () =>
            threadCreated
              ? Option.some(makeProjectedThread({ source: "codex", imported: historyImported }))
              : Option.none(),
        });
        const importOnce = () => runImport({ scanner, engine, directory, snapshots });

        expect(yield* importOnce()).toEqual({ importedCount: 0, skippedCount: 1 });
        expect(yield* importOnce()).toEqual({ importedCount: 0, skippedCount: 1 });
        expect(yield* importOnce()).toEqual({ importedCount: 1, skippedCount: 0 });
        const historyAttemptsAfterCompletion = historyAttemptCount;
        expect(yield* importOnce()).toEqual({ importedCount: 1, skippedCount: 0 });
        expect(historyAttemptCount).toBe(historyAttemptsAfterCompletion);
        expect(historyAttemptCount).toBe(2);
        expect(bindings).toHaveLength(1);
      }),
    );

    it.effect("does not replace completed history or an active binding on retry", () =>
      Effect.gen(function* () {
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () => Stream.fromIterable([makeThreadOutcome(makeThread("codex"))]),
        });
        const runningBinding: ProviderSessionDirectory.ProviderRuntimeBinding = {
          threadId: ThreadId.make("import:codex:codex-session"),
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "running",
          resumeCursor: { threadId: "newer-codex-session" },
        };
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: () => Effect.die("must not replace an active binding"),
          upsertIf: () => Effect.die("must not replace an active binding"),
          upsertIfCurrent: () => Effect.die("must not replace an active binding"),
          getProvider: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.void,
          getBinding: () => Effect.succeedSome(runningBinding),
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        });
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: () => Effect.die("must not replay history or settle active work"),
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        });

        const result = yield* runImport({
          scanner,
          engine,
          directory,
          snapshots: makeSnapshotsLayer({
            project: makeProject(),
            getThread: () =>
              Option.some(
                makeProjectedThread({ source: "codex", imported: true, includeFollowup: true }),
              ),
          }),
        });

        expect(result).toEqual({ importedCount: 1, skippedCount: 0 });
      }),
    );

    it.effect("skips malformed Claude ids and wrong-project thread collisions", () =>
      Effect.gen(function* () {
        const scanner = AgentSessionScanner.AgentSessionScanner.of({
          scan: Effect.die("unused"),
          recentThreads: () =>
            Stream.fromIterable([
              makeThreadOutcome({ ...makeThread("claudeAgent"), providerSessionId: "not-a-uuid" }),
              makeThreadOutcome(makeThread("codex")),
            ]),
        });
        const commands: Array<OrchestrationCommand> = [];
        const engine = OrchestrationEngine.OrchestrationEngineService.of({
          dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
          readEvents: () => Stream.empty,
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused"),
          streamDomainEvents: Stream.empty,
          subscribeDomainEvents: Effect.succeed(Stream.empty),
          latestSequence: Effect.succeed(0),
        });
        const directory = ProviderSessionDirectory.ProviderSessionDirectory.of({
          upsert: () => Effect.die("must not bind malformed or wrong-project sessions"),
          upsertIf: () => Effect.die("must not bind malformed or wrong-project sessions"),
          upsertIfCurrent: () => Effect.die("must not bind malformed or wrong-project sessions"),
          getProvider: () => Effect.die("unused"),
          recordImportedTranscript: () => Effect.die("unused"),
          getBinding: () => Effect.succeedNone,
          listThreadIds: () => Effect.die("unused"),
          listBindings: () => Effect.succeed([]),
        });

        const result = yield* runImport({
          scanner,
          engine,
          directory,
          snapshots: makeSnapshotsLayer({
            project: makeProject(),
            getThread: (threadId) =>
              threadId === "import:codex:codex-session"
                ? Option.some(
                    makeProjectedThread({
                      source: "codex",
                      projectId: ProjectId.make("project-other"),
                    }),
                  )
                : Option.none(),
          }),
        });

        expect(result).toEqual({ importedCount: 0, skippedCount: 2 });
        expect(commands).toHaveLength(0);
      }),
    );

    const makeRecordingEngine = (commands: Array<OrchestrationCommand>) =>
      OrchestrationEngine.OrchestrationEngineService.of({
        dispatch: (command) => Effect.sync(() => ({ sequence: commands.push(command) })),
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      });

    const makeWriteGuardedDirectory = (
      overrides: Partial<ProviderSessionDirectory.ProviderSessionDirectory["Service"]>,
    ) =>
      ProviderSessionDirectory.ProviderSessionDirectory.of({
        upsert: () => Effect.die("must not write a binding"),
        upsertIf: () => Effect.die("must not write a binding"),
        upsertIfCurrent: () => Effect.die("must not write a binding"),
        getProvider: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("must not record an import"),
        getBinding: () => Effect.die("must not read a binding"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
        ...overrides,
      });

    /** A stored row as the real directory returns it, with optional ownership metadata. */
    const makeOwnedBindingRow = (
      input: {
        readonly threadId?: ThreadId;
        readonly provider?: ProviderDriverKind;
        readonly providerInstanceId?: ProviderInstanceId;
        readonly resumeCursor?: unknown;
        readonly runtimePayload?: unknown;
        readonly status?: "starting" | "running" | "stopped" | "error";
      } = {},
    ): ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata => ({
      threadId: input.threadId ?? ThreadId.make("thread-owned-live"),
      provider: input.provider ?? ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: input.providerInstanceId ?? ProviderInstanceId.make("claudeAgent"),
      status: input.status ?? "stopped",
      resumeCursor: input.resumeCursor ?? null,
      runtimePayload: input.runtimePayload ?? null,
      lastSeenAt: "2026-08-24T09:00:00.000Z",
    });

    it.effect("fails closed when the ownership lookup fails before scanning", () =>
      Effect.gen(function* () {
        const recentThreads = vi.fn(() => Stream.empty);
        const lookupFailure = new ProviderSessionDirectoryPersistenceError({
          operation: "ProviderSessionDirectory.listBindings:list",
          detail: "Temporary session storage failure.",
        });
        const commands: Array<OrchestrationCommand> = [];

        const error = yield* runImport({
          scanner: AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads,
          }),
          engine: makeRecordingEngine(commands),
          directory: makeWriteGuardedDirectory({
            listBindings: () => Effect.fail(lookupFailure),
          }),
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        }).pipe(
          Effect.flip,
          Effect.filterOrFail(
            (failure): failure is AgentSessionScanError => failure._tag === "AgentSessionScanError",
            () => new Error("expected AgentSessionScanError"),
          ),
        );

        expect(error.operation).toBe("read-projects");
        expect(error.cause).toBe(lookupFailure);
        expect(recentThreads).not.toHaveBeenCalled();
        expect(commands).toHaveLength(0);
      }),
    );

    it.effect("fails closed when preserved ownership metadata is malformed", () =>
      Effect.gen(function* () {
        const recentThreads = vi.fn(() => Stream.empty);
        const commands: Array<OrchestrationCommand> = [];

        const error = yield* runImport({
          scanner: AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads,
          }),
          engine: makeRecordingEngine(commands),
          directory: makeWriteGuardedDirectory({
            listBindings: () =>
              Effect.succeed([
                makeOwnedBindingRow({
                  runtimePayload: { cwd: WORKSPACE_ROOT, priorProviderSessionIds: "not-an-array" },
                }),
              ]),
          }),
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        }).pipe(
          Effect.flip,
          Effect.filterOrFail(
            (failure): failure is AgentSessionScanError => failure._tag === "AgentSessionScanError",
            () => new Error("expected AgentSessionScanError"),
          ),
        );

        expect(error.cause).toMatchObject({ _tag: "ProviderSessionRefsMalformedError" });
        expect(recentThreads).not.toHaveBeenCalled();
        expect(commands).toHaveLength(0);
      }),
    );

    it.effect("fails the whole import when a per-thread ownership requery fails", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        let listBindingsCalls = 0;

        const error = yield* runImport({
          scanner: AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: () => Stream.fromIterable([makeThreadOutcome(makeThread("codex"))]),
          }),
          engine: makeRecordingEngine(commands),
          directory: makeWriteGuardedDirectory({
            getBinding: () => Effect.succeedNone,
            listBindings: () =>
              Effect.suspend(() => {
                listBindingsCalls += 1;
                // The preload sees nothing; the write-time requery hits a
                // binding row whose preserved metadata does not decode.
                return listBindingsCalls === 1
                  ? Effect.succeed([])
                  : Effect.succeed([
                      makeOwnedBindingRow({
                        provider: ProviderDriverKind.make("codex"),
                        providerInstanceId: ProviderInstanceId.make("codex"),
                        resumeCursor: { threadId: "codex-session" },
                        runtimePayload: { priorProviderSessionIds: 42 },
                      }),
                    ]);
              }),
          }),
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        }).pipe(
          Effect.flip,
          Effect.filterOrFail(
            (failure): failure is AgentSessionScanError => failure._tag === "AgentSessionScanError",
            () => new Error("expected AgentSessionScanError"),
          ),
        );

        expect(error.cause).toMatchObject({ _tag: "ProviderSessionRefsMalformedError" });
        // The requery sits outside the per-thread catch-as-skipped: the
        // failure fails the import instead of passing as a skipped count.
        expect(commands).toHaveLength(0);
      }),
    );

    it.effect("blocks a session that became owned after the initial snapshot", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        let upsertCount = 0;
        let listBindingsCalls = 0;

        const result = yield* runImport({
          scanner: AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: () => Stream.fromIterable([makeThreadOutcome(makeThread("codex"))]),
          }),
          engine: makeRecordingEngine(commands),
          directory: makeWriteGuardedDirectory({
            upsert: () => {
              upsertCount += 1;
              return Effect.void;
            },
            getBinding: () => Effect.succeedNone,
            listBindings: () =>
              Effect.suspend(() => {
                listBindingsCalls += 1;
                // A concurrent real session published its binding for this
                // native session between the snapshot and the write gate.
                return listBindingsCalls === 1
                  ? Effect.succeed([])
                  : Effect.succeed([
                      makeOwnedBindingRow({
                        provider: ProviderDriverKind.make("codex"),
                        providerInstanceId: ProviderInstanceId.make("codex"),
                        resumeCursor: { threadId: "codex-session" },
                      }),
                    ]);
              }),
          }),
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        });

        expect(result).toEqual({ importedCount: 0, skippedCount: 0 });
        expect(commands).toHaveLength(0);
        expect(upsertCount).toBe(0);
      }),
    );

    it.effect("rechecks ownership before recording a duplicate copy", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        const recorded: Array<ThreadId> = [];
        let listBindingsCalls = 0;

        const result = yield* runImport({
          scanner: AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: () =>
              Stream.fromIterable([
                makeThreadOutcome(makeThread("codex")),
                {
                  _tag: "Duplicate",
                  source: makeThreadOutcome(makeThread("codex")).source,
                } satisfies AgentSessionScanner.AgentSessionRecentThread,
              ]),
          }),
          engine: makeRecordingEngine(commands),
          directory: makeWriteGuardedDirectory({
            upsert: () => Effect.void,
            getBinding: () => Effect.succeedNone,
            recordImportedTranscript: (input) =>
              Effect.sync(() => void recorded.push(input.threadId)),
            listBindings: () =>
              Effect.suspend(() => {
                listBindingsCalls += 1;
                // The import itself passes the gate; the session becomes owned
                // right before the duplicate copy would be recorded.
                return listBindingsCalls === 3
                  ? Effect.succeed([
                      makeOwnedBindingRow({
                        provider: ProviderDriverKind.make("codex"),
                        providerInstanceId: ProviderInstanceId.make("codex"),
                        resumeCursor: { threadId: "codex-session" },
                      }),
                    ])
                  : Effect.succeed([]);
              }),
          }),
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        });

        expect(result).toEqual({ importedCount: 1, skippedCount: 0 });
        // One record from the import itself; the owned duplicate wrote none.
        expect(recorded).toHaveLength(1);
      }),
    );

    it.effect("fails the import without writes when ownership preload is interrupted", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        const releaseLookup = yield* Deferred.make<void>();
        const lookupStarted = yield* Deferred.make<void>();

        const exit = yield* importRecentAgentThreads({ projectId: PROJECT_ID }).pipe(
          Effect.provideService(
            AgentSessionScanner.AgentSessionScanner,
            AgentSessionScanner.AgentSessionScanner.of({
              scan: Effect.die("unused"),
              recentThreads: () => Stream.succeed(makeThreadOutcome(makeThread("codex"))),
            }),
          ),
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            makeRecordingEngine(commands),
          ),
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            makeWriteGuardedDirectory({
              listBindings: () =>
                Deferred.succeed(lookupStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseLookup)),
                  Effect.andThen(Effect.succeed([])),
                ),
            }),
          ),
          Effect.provide(makeSnapshotsLayer({ project: makeProject() })),
          Effect.forkChild,
        );

        yield* Deferred.await(lookupStarted);
        yield* Fiber.interrupt(exit);
        const completed = yield* Fiber.await(exit);
        expect(Exit.isFailure(completed)).toBe(true);
        if (Exit.isFailure(completed)) {
          expect(Cause.hasInterrupts(completed.cause)).toBe(true);
        }
        expect(commands).toHaveLength(0);
      }),
    );

    it.effect("fails without writes when the write-time ownership lookup is interrupted", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        let upsertCount = 0;
        let recorded = 0;
        const releaseLookup = yield* Deferred.make<void>();
        const lookupStarted = yield* Deferred.make<void>();
        let listBindingsCalls = 0;

        const importFiber = yield* importRecentAgentThreads({ projectId: PROJECT_ID }).pipe(
          Effect.provideService(
            AgentSessionScanner.AgentSessionScanner,
            AgentSessionScanner.AgentSessionScanner.of({
              scan: Effect.die("unused"),
              recentThreads: () => Stream.succeed(makeThreadOutcome(makeThread("codex"))),
            }),
          ),
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            makeRecordingEngine(commands),
          ),
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            makeWriteGuardedDirectory({
              upsert: () => {
                upsertCount += 1;
                return Effect.void;
              },
              getBinding: () => Effect.succeedNone,
              recordImportedTranscript: () => {
                recorded += 1;
                return Effect.void;
              },
              listBindings: () =>
                Effect.suspend(() => {
                  listBindingsCalls += 1;
                  return listBindingsCalls === 1
                    ? Effect.succeed([])
                    : Deferred.succeed(lookupStarted, undefined).pipe(
                        Effect.andThen(Deferred.await(releaseLookup)),
                        Effect.andThen(Effect.succeed([])),
                      );
                }),
            }),
          ),
          Effect.provide(makeSnapshotsLayer({ project: makeProject() })),
          Effect.forkChild,
        );

        yield* Deferred.await(lookupStarted);
        yield* Fiber.interrupt(importFiber);
        const completed = yield* Fiber.await(importFiber);
        expect(Exit.isFailure(completed)).toBe(true);
        if (Exit.isFailure(completed)) {
          expect(Cause.hasInterrupts(completed.cause)).toBe(true);
        }
        expect(commands).toHaveLength(0);
        expect(upsertCount).toBe(0);
        expect(recorded).toBe(0);
      }),
    );

    it.effect("preserves a mixed interrupt cause from the write-time ownership lookup", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        let listBindingsCalls = 0;
        const persistenceFailure = new ProviderSessionDirectoryPersistenceError({
          operation: "ProviderSessionDirectory.listBindings:list",
          detail: "Injected lookup failure.",
        });
        const mixedCause = Cause.combine(Cause.fail(persistenceFailure), Cause.interrupt());

        const completed = yield* importRecentAgentThreads({ projectId: PROJECT_ID }).pipe(
          Effect.provideService(
            AgentSessionScanner.AgentSessionScanner,
            AgentSessionScanner.AgentSessionScanner.of({
              scan: Effect.die("unused"),
              recentThreads: () => Stream.succeed(makeThreadOutcome(makeThread("codex"))),
            }),
          ),
          Effect.provideService(
            OrchestrationEngine.OrchestrationEngineService,
            makeRecordingEngine(commands),
          ),
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            makeWriteGuardedDirectory({
              getBinding: () => Effect.succeedNone,
              listBindings: () =>
                Effect.suspend(() => {
                  listBindingsCalls += 1;
                  return listBindingsCalls === 1
                    ? Effect.succeed([])
                    : Effect.failCause(mixedCause);
                }),
            }),
          ),
          Effect.provide(makeSnapshotsLayer({ project: makeProject() })),
          Effect.exit,
        );

        expect(Exit.isFailure(completed)).toBe(true);
        if (Exit.isFailure(completed)) {
          expect(completed.cause.reasons.map((reason) => reason._tag)).toEqual(
            mixedCause.reasons.map((reason) => reason._tag),
          );
          const failures = completed.cause.reasons.filter(Cause.isFailReason);
          expect(failures).toHaveLength(1);
          expect(failures[0]?.error).toBe(persistenceFailure);
          expect(
            completed.cause.reasons.filter(Cause.isInterruptReason).map((reason) => reason.fiberId),
          ).toEqual(
            mixedCause.reasons.filter(Cause.isInterruptReason).map((reason) => reason.fiberId),
          );
          expect(Cause.hasInterrupts(completed.cause)).toBe(true);
        }
        expect(commands).toHaveLength(0);
      }),
    );

    it.effect("blocks a write when ownership publishes during preparatory reads", () =>
      Effect.gen(function* () {
        const commands: Array<OrchestrationCommand> = [];
        let upsertCount = 0;
        const preparatoryReadHeld = yield* Deferred.make<void>();
        const releasePreparatoryRead = yield* Deferred.make<void>();
        let listBindingsCalls = 0;

        const importFiber = yield* runImport({
          scanner: AgentSessionScanner.AgentSessionScanner.of({
            scan: Effect.die("unused"),
            recentThreads: () => Stream.fromIterable([makeThreadOutcome(makeThread("codex"))]),
          }),
          engine: makeRecordingEngine(commands),
          directory: makeWriteGuardedDirectory({
            upsert: () => {
              upsertCount += 1;
              return Effect.void;
            },
            getBinding: () =>
              Deferred.succeed(preparatoryReadHeld, undefined).pipe(
                Effect.andThen(Deferred.await(releasePreparatoryRead)),
                Effect.andThen(Effect.succeedNone),
              ),
            listBindings: () =>
              Effect.suspend(() => {
                listBindingsCalls += 1;
                return listBindingsCalls === 1
                  ? Effect.succeed([])
                  : Effect.succeed([
                      makeOwnedBindingRow({
                        provider: ProviderDriverKind.make("codex"),
                        providerInstanceId: ProviderInstanceId.make("codex"),
                        resumeCursor: { threadId: "codex-session" },
                      }),
                    ]);
              }),
          }),
          snapshots: makeSnapshotsLayer({ project: makeProject() }),
        }).pipe(Effect.forkChild);

        yield* Deferred.await(preparatoryReadHeld);
        yield* Deferred.succeed(releasePreparatoryRead, undefined);
        const result = yield* Fiber.join(importFiber);
        expect(result).toEqual({ importedCount: 0, skippedCount: 0 });
        expect(commands).toHaveLength(0);
        expect(upsertCount).toBe(0);
      }),
    );
  });
});

const integrationThread = {
  ...makeThread("codex"),
  updatedAt: "2026-08-24T10:00:00.000Z",
  messages: Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
    text: `Message ${index}`,
    createdAt: "2026-08-24T10:00:00.000Z",
  })),
};
const integrationScanner = AgentSessionScanner.AgentSessionScanner.of({
  scan: Effect.die("unused"),
  recentThreads: () => Stream.fromIterable([makeThreadOutcome(integrationThread)]),
});
const integrationServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-agent-session-importer-test-",
});
const integrationRuntimeRepository = ProviderSessionRuntime.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
);
const integrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  integrationRuntimeRepository,
  ProviderSafetyObservations.layer,
  ProviderSessionDirectoryLive.pipe(Layer.provide(integrationRuntimeRepository)),
  Layer.succeed(AgentSessionScanner.AgentSessionScanner, integrationScanner),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  // provideMerge keeps the same SqlitePersistenceMemory instance in the layer
  // output, so ambient `yield* SqlClient` in tests resolves the one live
  // in-memory database — no second database is created.
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(integrationServerConfig),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(restartContinuationsLayer),
);

it.layer(integrationLayer)("AgentSessionImporter integration", (it) => {
  it.effect("imports once after the real engine persists an old rejected receipt", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = ThreadId.make("import:codex:codex-session");

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-import-integration-project"),
        projectId: PROJECT_ID,
        title: "Project",
        workspaceRoot: WORKSPACE_ROOT,
        defaultModelSelection: null,
        createdAt: "2026-08-24T09:00:00.000Z",
      });
      const rejected = yield* Effect.result(
        engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make(`agent-session:history:${threadId}`),
          threadId,
          messages: [
            {
              messageId: MessageId.make(`${threadId}:000000`),
              role: "user",
              text: "Fix the bug",
              createdAt: "2026-08-24T10:00:00.000Z",
            },
          ],
        }),
      );
      expect(rejected._tag).toBe("Failure");

      const result = yield* importRecentAgentThreads({ projectId: PROJECT_ID });
      const importedThread = yield* snapshots.getThreadDetailById(threadId);
      const binding = yield* directory.getBinding(threadId);

      expect(result).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(Option.getOrThrow(importedThread).messages.map((message) => message.text)).toEqual(
        integrationThread.messages.map((message) => message.text),
      );
      expect(Option.getOrThrow(importedThread).settledOverride).toBe("settled");
      expect(Option.getOrThrow(importedThread).updatedAt).toBe("2026-08-24T10:00:00.000Z");
      expect(Option.getOrThrow(binding)).toMatchObject({
        provider: "codex",
        providerInstanceId: "codex",
        resumeCursor: { threadId: "codex-session" },
        runtimePayload: { cwd: WORKSPACE_ROOT },
      });

      yield* engine.dispatch({
        type: "thread.revert.complete",
        commandId: CommandId.make("revert-imported-thread-to-baseline"),
        threadId,
        turnCount: 0,
        createdAt: "2026-08-24T10:05:00.000Z",
      });
      const afterRevert = yield* snapshots.getThreadDetailById(threadId);
      expect(Option.getOrThrow(afterRevert).messages.map((message) => message.text)).toEqual(
        integrationThread.messages.map((message) => message.text),
      );
    }),
  );

  it.effect(
    "retries a bounded import after scanner restart without rereading completed transcripts",
    () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-import-retry-",
        });
        const workspaceRoot = path.join(fixtureDir, "workspace");
        const claudeHomePath = path.join(fixtureDir, "claude");
        const codexHomePath = path.join(fixtureDir, "codex");
        const sessionsDir = path.join(codexHomePath, "sessions", "2026", "08", "24");
        yield* fileSystem.makeDirectory(workspaceRoot);
        yield* fileSystem.makeDirectory(claudeHomePath);
        yield* fileSystem.makeDirectory(sessionsDir, { recursive: true });

        const projectId = ProjectId.make("project-bounded-import-retry");
        const transcripts = Array.from({ length: 101 }, (_, index) => {
          const providerSessionId = `bounded-session-${String(index).padStart(3, "0")}`;
          return {
            providerSessionId,
            threadId: ThreadId.make(`import:codex:${providerSessionId}`),
            filePath: path.join(sessionsDir, `rollout-${providerSessionId}.jsonl`),
          };
        });
        for (const [index, transcript] of transcripts.entries()) {
          yield* fileSystem.writeFileString(
            transcript.filePath,
            [
              encodeTranscriptRecord({
                type: "session_meta",
                payload: { id: transcript.providerSessionId, cwd: workspaceRoot },
              }),
              encodeTranscriptRecord({
                type: "event_msg",
                payload: {
                  type: "user_message",
                  message: `Prompt ${transcript.providerSessionId}`,
                },
              }),
            ].join("\n"),
          );
          const seconds = nowMs / 1_000 - index;
          yield* fileSystem.utimes(transcript.filePath, seconds, seconds);
        }
        const legacy = transcripts[0]!;
        const failed = transcripts[1]!;
        const remaining = transcripts[100]!;
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make("create-bounded-import-project"),
          projectId,
          title: "Bounded import",
          workspaceRoot,
          defaultModelSelection: null,
          createdAt: "2026-08-24T09:00:00.000Z",
        });

        // This completed import predates persisted transcript source metadata.
        yield* directory.upsert({
          threadId: legacy.threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "stopped",
          resumeCursor: { threadId: "legacy-current-session" },
          runtimePayload: { cwd: workspaceRoot },
        });
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create-legacy-bounded-import"),
          threadId: legacy.threadId,
          projectId,
          title: "Legacy import",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: "2026-08-24T10:00:00.000Z",
          historyImport: true,
        });
        yield* engine.dispatch({
          type: "thread.history.import",
          commandId: CommandId.make("import-legacy-bounded-history"),
          threadId: legacy.threadId,
          messages: [
            {
              messageId: MessageId.make(`${legacy.threadId}:000000`),
              role: "user",
              text: "Legacy imported history",
              createdAt: "2026-08-24T10:00:00.000Z",
            },
          ],
        });
        expect(yield* snapshots.getImportedAgentSessionSources(projectId)).toEqual([]);

        let failHistory = true;
        const importerEngine = OrchestrationEngine.OrchestrationEngineService.of({
          ...engine,
          dispatch: (command) => {
            if (
              failHistory &&
              command.type === "thread.history.import" &&
              command.threadId === failed.threadId
            ) {
              failHistory = false;
              return Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "Injected history import failure.",
                }),
              );
            }
            return engine.dispatch(command);
          },
        });
        const settingsLayer = ServerSettingsService.layerTest({
          providers: {
            claudeAgent: { homePath: claudeHomePath },
            codex: { homePath: codexHomePath },
          },
        });
        const transcriptPaths = new Set(transcripts.map((transcript) => transcript.filePath));
        const runAttempt = Effect.fn("runBoundedImportAttempt")(function* (
          completedPaths: ReadonlySet<string>,
        ) {
          const openCounts = new Map<string, number>();
          const fullReads: string[] = [];
          const observedFileSystem = FileSystem.FileSystem.of({
            ...fileSystem,
            open: (filePath, options) =>
              Effect.suspend(() => {
                if (transcriptPaths.has(filePath)) {
                  const count = (openCounts.get(filePath) ?? 0) + 1;
                  openCounts.set(filePath, count);
                  // A fresh scanner first opens each file for project discovery.
                  if (count > 1) {
                    fullReads.push(filePath);
                    if (completedPaths.has(filePath)) {
                      return Effect.die(new Error(`Completed transcript reopened: ${filePath}`));
                    }
                  }
                }
                return fileSystem.open(filePath, options);
              }),
          });
          const result = yield* importRecentAgentThreads({ projectId }).pipe(
            Effect.provide(
              Layer.fresh(AgentSessionScanner.layer).pipe(
                Layer.provide(settingsLayer),
                Layer.provide(Layer.succeed(FileSystem.FileSystem, observedFileSystem)),
              ),
            ),
            Effect.provideService(OrchestrationEngine.OrchestrationEngineService, importerEngine),
          );
          return { result, fullReads, openCounts };
        });

        const first = yield* runAttempt(new Set());
        expect(first.result).toEqual({ importedCount: 99, skippedCount: 2 });
        expect(failHistory).toBe(false);
        expect(first.fullReads).toEqual(transcripts.slice(0, 100).map((entry) => entry.filePath));
        expect(first.openCounts.get(remaining.filePath)).toBe(1);
        const completedSources = yield* snapshots.getImportedAgentSessionSources(projectId);
        expect(completedSources).toHaveLength(99);
        expect(completedSources).toContainEqual({
          threadId: legacy.threadId,
          source: expect.objectContaining({ filePath: legacy.filePath }),
        });
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(failed.threadId)).messages,
        ).toEqual([]);
        expect(Option.getOrThrow(yield* directory.getBinding(failed.threadId))).toMatchObject({
          status: "stopped",
          resumeCursor: { threadId: failed.providerSessionId },
        });
        expect(Option.isNone(yield* snapshots.getThreadDetailById(remaining.threadId))).toBe(true);

        const completedPaths = new Set(completedSources.map((entry) => entry.source.filePath));
        const second = yield* runAttempt(completedPaths);
        // Bounded retry after a partial failure: the failed Codex install owns
        // its native id without validated completed history, so the second pass
        // still parses that rollout once (filename cannot prove ownership) but
        // omits the re-import; only the remaining session is newly imported.
        expect(second.result).toEqual({ importedCount: 100, skippedCount: 0 });
        expect(second.fullReads).toEqual([failed.filePath, remaining.filePath]);
        for (const transcript of transcripts) {
          expect(second.openCounts.get(transcript.filePath)).toBe(
            completedPaths.has(transcript.filePath)
              ? 1
              : transcript === failed || transcript === remaining
                ? 2
                : 1,
          );
        }
        const sourcesAfterRetry = yield* snapshots.getImportedAgentSessionSources(projectId);
        expect(sourcesAfterRetry).toHaveLength(100);
        expect(sourcesAfterRetry.map((entry) => entry.threadId)).not.toContain(failed.threadId);
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(legacy.threadId)).messages.map(
            (message) => message.text,
          ),
        ).toEqual(["Legacy imported history"]);
        expect(
          Option.getOrThrow(yield* directory.getBinding(legacy.threadId)).resumeCursor,
        ).toEqual({
          threadId: "legacy-current-session",
        });
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(remaining.threadId)).messages.map(
            (message) => message.text,
          ),
        ).toEqual([`Prompt ${remaining.providerSessionId}`]);
        expect(
          Option.getOrThrow(yield* snapshots.getThreadDetailById(failed.threadId)).messages,
        ).toEqual([]);
      }),
  );

  for (const source of ["codex", "claudeAgent"] as const) {
    it.effect(`resumes imported ${source} history only after the first prompt`, () =>
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngine.OrchestrationEngineService;
        const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const safetyObservations = yield* ProviderSafetyObservations.ProviderSafetyObservations;
        const fileSystem = yield* FileSystem.FileSystem;
        const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped();
        const projectId = ProjectId.make(`project-import-resume-${source}`);
        const sourceThread = {
          ...makeThread(source),
          providerSessionId: source === "codex" ? "codex-first-resume" : CLAUDE_SESSION_ID,
        };
        const threadId = ThreadId.make(
          `import:${sourceThread.providerInstanceId}:${sourceThread.providerSessionId}`,
        );
        const resumeCursor =
          source === "codex"
            ? { threadId: sourceThread.providerSessionId }
            : { threadId, resume: sourceThread.providerSessionId };
        const provider = ProviderDriverKind.make(source);
        const harness = yield* makeTestProviderAdapterHarness({ provider });
        const importSettled = yield* Deferred.make<void>();
        const turnSent = yield* Deferred.make<void>();
        const startSession = vi.fn(harness.adapter.startSession);
        const sendTurn = vi.fn((input: ProviderSendTurnInput) =>
          harness.adapter
            .sendTurn(input)
            .pipe(Effect.tap(() => Deferred.succeed(turnSent, undefined))),
        );
        const providerLayer = makeProviderServiceLive().pipe(
          Layer.provide(
            Layer.succeed(
              ProviderAdapterRegistry,
              makeAdapterRegistryMock({
                [provider]: { ...harness.adapter, startSession, sendTurn },
              }),
            ),
          ),
          Layer.provide(
            Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, directory),
          ),
          Layer.provide(
            Layer.succeed(
              ProviderSafetyObservations.ProviderSafetyObservations,
              safetyObservations,
            ),
          ),
          Layer.provide(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
          Layer.provide(AnalyticsService.layerTest),
        );
        const continuations = yield* RestartContinuations;
        const reactorLayer = ProviderCommandReactorLive.pipe(
          // Import privacy is asserted against the reactor without memory sends,
          // so the fail-closed unavailable gate layer stands in for the real one.
          Layer.provide(projectMemorySendGateLayerUnavailable),
          Layer.provideMerge(providerLayer),
          // The ambient engine instance is handed to the provider inside the
          // reactor build, keeping one token map across both consumers.
          Layer.provide(Layer.succeed(RestartContinuations, continuations)),
          Layer.provide(
            Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
              ...snapshots,
              // Acknowledge the imported settlement before draining the reactor.
              getThreadShellById: (requestedThreadId) =>
                snapshots
                  .getThreadShellById(requestedThreadId)
                  .pipe(
                    Effect.tap(() =>
                      requestedThreadId === threadId
                        ? Deferred.succeed(importSettled, undefined)
                        : Effect.void,
                    ),
                  ),
            }),
          ),
          Layer.provide(
            Layer.mock(ProviderAuthService)({
              tryHandlePromptCommand: () => Effect.succeed(false),
            }),
          ),
          Layer.provide(makeProviderRegistryLayer()),
          Layer.provide(Layer.mock(GitWorkflowService)({})),
          Layer.provide(Layer.mock(VcsStatusBroadcaster)({})),
          Layer.provide(Layer.mock(TextGeneration)({})),
          Layer.provide(Layer.mock(TerminalManager)({ closeIdle: () => Effect.void })),
          Layer.provide(ServerSettingsService.layerTest()),
        );

        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(`create-import-resume-project-${source}`),
          projectId,
          title: "Import resume",
          workspaceRoot,
          defaultModelSelection: null,
          createdAt: "2026-08-24T09:00:00.000Z",
        });
        yield* harness.queueTurnResponseForNextSession({ events: [] });

        yield* Effect.gen(function* () {
          const reactor = yield* ProviderCommandReactor;
          yield* reactor.start();
          expect(yield* importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          yield* Deferred.await(importSettled);
          yield* reactor.drain;
          expect(startSession).not.toHaveBeenCalled();
          expect(sendTurn).not.toHaveBeenCalled();
          const importedThread = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
          expect(importedThread.session).toBeNull();
          expect(importedThread.latestTurn).toBeNull();

          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(`resume-imported-${source}`),
            threadId,
            message: {
              messageId: MessageId.make(`resume-imported-message-${source}`),
              role: "user",
              text: "Continue this session",
              attachments: [],
            },
            modelSelection: importedThread.modelSelection,
            runtimeMode: importedThread.runtimeMode,
            interactionMode: importedThread.interactionMode,
            createdAt: "2026-08-24T10:02:00.000Z",
          });
          yield* Deferred.await(turnSent);
          yield* reactor.drain;
          expect(startSession).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
              threadId,
              provider,
              providerInstanceId: sourceThread.providerInstanceId,
              resumeCursor,
              cwd: workspaceRoot,
            }),
          );
          expect(sendTurn).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ threadId, input: "Continue this session" }),
          );
          expect(Option.getOrThrow(yield* directory.getBinding(threadId))).toMatchObject({
            provider,
            providerInstanceId: sourceThread.providerInstanceId,
            resumeCursor,
          });
        }).pipe(
          Effect.provide(reactorLayer),
          Effect.provideService(
            AgentSessionScanner.AgentSessionScanner,
            AgentSessionScanner.AgentSessionScanner.of({
              scan: Effect.die("unused"),
              recentThreads: () => Stream.succeed(makeThreadOutcome(sourceThread)),
            }),
          ),
        );
      }),
    );
  }

  it.effect("persists the resume cursor before publishing a new imported thread", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const projectId = ProjectId.make("project-import-binding-race");
      const workspaceRoot = "/tmp/project-import-binding-race";
      const providerSessionId = "codex-binding-race";
      const threadId = ThreadId.make(`import:codex:${providerSessionId}`);
      const scanner = AgentSessionScanner.AgentSessionScanner.of({
        scan: Effect.die("unused"),
        recentThreads: () =>
          Stream.succeed(
            makeThreadOutcome({ ...integrationThread, providerSessionId, title: "Binding race" }),
          ),
      });
      const importerAtBindingWrite = yield* Deferred.make<void>();
      const releaseImporter = yield* Deferred.make<void>();
      const importerRepository = ProviderSessionRuntime.ProviderSessionRuntimeRepository.of({
        ...repository,
        upsert: (runtime, options) =>
          options?.onConflict === "ignore"
            ? Deferred.succeed(importerAtBindingWrite, undefined).pipe(
                Effect.andThen(Deferred.await(releaseImporter)),
                Effect.andThen(repository.upsert(runtime, options)),
              )
            : repository.upsert(runtime, options),
      });
      const sql = yield* SqlClient.SqlClient;
      const importerDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory.pipe(
        Effect.provide(
          Layer.fresh(ProviderSessionDirectoryLive).pipe(
            Layer.provide(
              Layer.succeed(
                ProviderSessionRuntime.ProviderSessionRuntimeRepository,
                importerRepository,
              ),
            ),
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          ),
        ),
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-import-binding-race-project"),
        projectId,
        title: "Binding race",
        workspaceRoot,
        defaultModelSelection: null,
        createdAt: "2026-08-24T09:00:00.000Z",
      });

      const importFiber = yield* importRecentAgentThreads({ projectId }).pipe(
        Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, importerDirectory),
        Effect.forkChild,
      );

      yield* Effect.raceFirst(
        Deferred.await(importerAtBindingWrite),
        Fiber.join(importFiber).pipe(
          Effect.flatMap((result) =>
            Effect.die(
              new Error(`Import completed before the binding write: ${JSON.stringify(result)}`),
            ),
          ),
        ),
      );
      expect(Option.isNone(yield* snapshots.getThreadDetailById(threadId))).toBe(true);

      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        resumeCursor: { threadId: "active-client-session" },
        runtimePayload: { cwd: workspaceRoot, activeTurnId: "turn-active" },
      });
      yield* Deferred.succeed(releaseImporter, undefined);

      expect(yield* Fiber.join(importFiber)).toEqual({ importedCount: 1, skippedCount: 0 });
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId)).messages.map(
          (message) => message.text,
        ),
      ).toEqual(integrationThread.messages.map((message) => message.text));
      expect(Option.getOrThrow(yield* directory.getBinding(threadId))).toMatchObject({
        status: "running",
        resumeCursor: { threadId: "active-client-session" },
        runtimePayload: { cwd: workspaceRoot, activeTurnId: "turn-active" },
      });
    }),
  );

  it.effect("does not import history over a turn started on a partial thread", () =>
    Effect.gen(function* () {
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const projectId = ProjectId.make("project-import-turn-race");
      const workspaceRoot = "/tmp/project-import-turn-race";
      const providerSessionId = "codex-turn-race";
      const threadId = ThreadId.make(`import:codex:${providerSessionId}`);
      const scanner = AgentSessionScanner.AgentSessionScanner.of({
        scan: Effect.die("unused"),
        recentThreads: () =>
          Stream.succeed(
            makeThreadOutcome({ ...integrationThread, providerSessionId, title: "Turn race" }),
          ),
      });
      const importerAtBindingWrite = yield* Deferred.make<void>();
      const releaseImporter = yield* Deferred.make<void>();
      const importerRepository = ProviderSessionRuntime.ProviderSessionRuntimeRepository.of({
        ...repository,
        upsert: (runtime, options) =>
          options?.onConflict === "ignore"
            ? Deferred.succeed(importerAtBindingWrite, undefined).pipe(
                Effect.andThen(Deferred.await(releaseImporter)),
                Effect.andThen(repository.upsert(runtime, options)),
              )
            : repository.upsert(runtime, options),
      });
      const sql = yield* SqlClient.SqlClient;
      const importerDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory.pipe(
        Effect.provide(
          Layer.fresh(ProviderSessionDirectoryLive).pipe(
            Layer.provide(
              Layer.succeed(
                ProviderSessionRuntime.ProviderSessionRuntimeRepository,
                importerRepository,
              ),
            ),
            Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
          ),
        ),
      );

      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-import-turn-race-project"),
        projectId,
        title: "Turn race",
        workspaceRoot,
        defaultModelSelection: null,
        createdAt: "2026-08-24T09:00:00.000Z",
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-import-turn-race-thread"),
        threadId,
        projectId,
        title: "Turn race",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "default" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-08-24T10:00:00.000Z",
      });

      const importFiber = yield* importRecentAgentThreads({ projectId }).pipe(
        Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
        Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, importerDirectory),
        Effect.forkChild,
      );
      yield* Deferred.await(importerAtBindingWrite);

      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "running",
        resumeCursor: { threadId: "active-client-session" },
        runtimePayload: { cwd: workspaceRoot, activeTurnId: "turn-active" },
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("start-turn-during-import"),
        threadId,
        message: {
          messageId: MessageId.make("message-during-import"),
          role: "user",
          text: "Continue while import waits",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-08-24T10:02:00.000Z",
      });
      yield* Deferred.succeed(releaseImporter, undefined);

      expect(yield* Fiber.join(importFiber)).toEqual({ importedCount: 0, skippedCount: 1 });
      expect(Option.getOrThrow(yield* directory.getBinding(threadId))).toMatchObject({
        status: "running",
        resumeCursor: { threadId: "active-client-session" },
        runtimePayload: { cwd: workspaceRoot, activeTurnId: "turn-active" },
      });
      expect(
        Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId)).messages.map(
          (message) => message.text,
        ),
      ).toEqual(["Continue while import waits"]);
    }),
  );

  const UUID_OWNED = "0e2d1c86-5a10-4a6e-9d24-6f2b1c0a5e01";
  const UUID_UNRELATED = "8b1c3f2a-7d94-4e15-b2a6-3c5d9e0f1a02";
  const UUID_SHARED = "27c4b1e0-93f8-4c22-8a51-4d7e6b2f9c03";

  const claudeTranscript = (cwd: string, sessionId: string, text: string) =>
    `${JSON.stringify({
      type: "user",
      cwd,
      sessionId,
      timestamp: "2026-08-24T10:00:00.000Z",
      message: { role: "user", content: text },
    })}\n${JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: "2026-08-24T10:01:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    })}\n`;

  const writeClaudeTranscriptFile = Effect.fn("AgentSessionImporter.test.writeClaudeTranscript")(
    function* (input: {
      readonly claudeHomePath: string;
      readonly fileName: string;
      readonly cwd: string;
      readonly sessionId: string;
      readonly text: string;
      /** Pinned to the frozen test clock: a real write time would be future-dated. */
      readonly mtimeMs: number;
    }) {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filePath = path.join(input.claudeHomePath, "projects", "p", input.fileName);
      yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fileSystem.writeFileString(
        filePath,
        claudeTranscript(input.cwd, input.sessionId, input.text),
      );
      yield* fileSystem.utimes(filePath, input.mtimeMs / 1_000, input.mtimeMs / 1_000);
      return filePath;
    },
  );

  /**
   * One phase of an owned-import scenario: a fresh real scanner over the
   * fixture homes plus the real engine, projections, and directory over their
   * own connections to one file-backed SQLite database. Every provide builds
   * on a local memo map, so the phase graph can never be satisfied from the
   * outer it.layer's shared in-memory instance; sequential phases close and
   * reopen the database — the restart proof — while earlier rows persist.
   */
  const runOwnershipPhase = (
    dbPath: string,
    settingsLayer: Layer.Layer<ServerSettingsService, ServerSettingsError>,
  ) => {
    // One layer value per phase: every consumer shares a single connection,
    // and each phase call rebuilds it, closing and reopening the same file.
    const persistence = makeSqlitePersistenceLive(dbPath);
    const runtimeRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(persistence));
    const appGraph = Layer.mergeAll(
      OrchestrationEngineLive.pipe(
        Layer.provide(OrchestrationProjectionSnapshotQueryLive),
        Layer.provide(OrchestrationProjectionPipelineLive),
      ),
      OrchestrationProjectionSnapshotQueryLive,
      runtimeRepository,
      ProviderSafetyObservations.layer,
      // The directory needs the repository AND the same SqlClient instance;
      // merging persistence beside the repository only exports the service.
      ProviderSessionDirectoryLive.pipe(
        Layer.provide(Layer.mergeAll(runtimeRepository, persistence)),
      ),
      Layer.fresh(AgentSessionScanner.layer).pipe(Layer.provide(settingsLayer)),
    ).pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provideMerge(persistence),
      Layer.provideMerge(integrationServerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(restartContinuationsLayer),
      Layer.provideMerge(projectMemoriesLayer.pipe(Layer.provide(persistence))),
    );
    return <A, E2, R>(inner: Effect.Effect<A, E2, R>) =>
      inner.pipe(Effect.provide(appGraph, { local: true }));
  };

  const makeOwnedProject = Effect.fn("AgentSessionImporter.test.makeOwnedProject")(function* (
    engine: OrchestrationEngine.OrchestrationEngineService["Service"],
    input: {
      readonly projectId: ProjectId;
      readonly workspaceRoot: string;
      readonly label: string;
    },
  ) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`create-${input.label}`),
      projectId: input.projectId,
      title: "Owned import",
      workspaceRoot: input.workspaceRoot,
      defaultModelSelection: null,
      createdAt: "2026-08-24T09:00:00.000Z",
    });
  });

  it.effect(
    "imports only the unrelated transcript when a stopped binding owns the other session",
    () =>
      Effect.gen(function* () {
        const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
        yield* TestClock.setTime(nowMs);
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-import-owned-basic-",
        });
        const workspaceRoot = path.join(fixtureDir, "workspace");
        const claudeHomePath = path.join(fixtureDir, "claude");
        const codexHomePath = path.join(fixtureDir, "codex");
        const dbPath = path.join(fixtureDir, "userdata", "state.sqlite");
        yield* fileSystem.makeDirectory(workspaceRoot);
        yield* writeClaudeTranscriptFile({
          claudeHomePath,
          fileName: `${UUID_OWNED}.jsonl`,
          cwd: workspaceRoot,
          sessionId: UUID_OWNED,
          text: "Owned secret marker",
          mtimeMs: nowMs - 60_000,
        });
        yield* writeClaudeTranscriptFile({
          claudeHomePath,
          fileName: `${UUID_UNRELATED}.jsonl`,
          cwd: workspaceRoot,
          sessionId: UUID_UNRELATED,
          text: "Unrelated prompt",
          mtimeMs: nowMs - 120_000,
        });
        const settingsLayer = ServerSettingsService.layerTest({
          providers: {
            claudeAgent: { homePath: claudeHomePath },
            codex: { homePath: codexHomePath },
          },
        });
        const phase = runOwnershipPhase(dbPath, settingsLayer);
        const projectId = ProjectId.make("project-owned-basic");
        const ownedThreadId = ThreadId.make("thread-owned-alias");

        const first = yield* phase(
          Effect.gen(function* () {
            const engine = yield* OrchestrationEngine.OrchestrationEngineService;
            const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
            yield* makeOwnedProject(engine, { projectId, workspaceRoot, label: "owned-basic" });
            // The app's own thread owns one of the two Claude sessions. Its
            // instance is an alias: the scanner resolves the built-in instance
            // for the shared home, so exclusion must be alias-insensitive.
            yield* directory.upsert({
              threadId: ownedThreadId,
              provider: ProviderDriverKind.make("claudeAgent"),
              providerInstanceId: ProviderInstanceId.make("claude-work"),
              status: "stopped",
              resumeCursor: { threadId: ownedThreadId, resume: UUID_OWNED },
              runtimePayload: { cwd: workspaceRoot },
            });
            return yield* importRecentAgentThreads({ projectId });
          }),
        );
        expect(first).toEqual({ importedCount: 1, skippedCount: 0 });

        // Reopened connections: the unrelated session is really imported while
        // the owned one has no thread, no binding, and no recorded source.
        yield* phase(
          Effect.gen(function* () {
            const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
            const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
            const importedThread = Option.getOrThrow(
              yield* snapshots.getThreadDetailById(
                ThreadId.make(`import:claudeAgent:${UUID_UNRELATED}`),
              ),
            );
            expect(importedThread.messages.map((message) => message.text)).toEqual([
              "Unrelated prompt",
              "Done",
            ]);
            expect(importedThread.settledOverride).toBe("settled");
            expect(
              Option.isNone(
                yield* snapshots.getThreadDetailById(
                  ThreadId.make(`import:claudeAgent:${UUID_OWNED}`),
                ),
              ),
            ).toBe(true);
            expect(
              Option.isNone(
                yield* directory.getBinding(ThreadId.make(`import:claudeAgent:${UUID_OWNED}`)),
              ),
            ).toBe(true);
            expect(
              (yield* snapshots.getImportedAgentSessionSources(projectId)).map(
                (entry) => entry.source.providerSessionId,
              ),
            ).toEqual([UUID_UNRELATED]);
          }),
        );

        const third = yield* phase(
          Effect.gen(function* () {
            return yield* importRecentAgentThreads({ projectId });
          }),
        );
        // The unchanged unrelated transcript keeps its validated
        // AlreadyImported count; the owned session stays excluded.
        expect(third).toEqual({ importedCount: 1, skippedCount: 0 });
      }),
  );

  it.effect("keeps excluding the owned session after thread and project deletion", () =>
    Effect.gen(function* () {
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-import-owned-delete-",
      });
      const workspaceRoot = path.join(fixtureDir, "workspace");
      const claudeHomePath = path.join(fixtureDir, "claude");
      const codexHomePath = path.join(fixtureDir, "codex");
      const dbPath = path.join(fixtureDir, "userdata", "state.sqlite");
      yield* fileSystem.makeDirectory(workspaceRoot);
      const ownedMarker = "Owned secret marker";
      const settingsLayer = ServerSettingsService.layerTest({
        providers: {
          claudeAgent: { homePath: claudeHomePath },
          codex: { homePath: codexHomePath },
        },
      });
      const phase = runOwnershipPhase(dbPath, settingsLayer);
      const projectId = ProjectId.make("project-owned-delete");
      const recreatedProjectId = ProjectId.make("project-owned-delete-recreated");
      const ownedThreadId = ThreadId.make("thread-owned-deleted");

      const memoryId = ProjectMemoryId.make("memory-owned-delete-marker");

      yield* phase(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const memoryRepository = yield* ProjectMemoryRepository;
          yield* makeOwnedProject(engine, { projectId, workspaceRoot, label: "owned-delete" });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-owned-thread"),
            threadId: ownedThreadId,
            projectId,
            title: "Owned live thread",
            modelSelection: {
              instanceId: ProviderInstanceId.make("claude-work"),
              model: "default",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdAt: "2026-08-24T09:10:00.000Z",
          });
          yield* directory.upsert({
            threadId: ownedThreadId,
            provider: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId: ProviderInstanceId.make("claude-work"),
            status: "stopped",
            resumeCursor: { threadId: ownedThreadId, resume: UUID_OWNED },
            runtimePayload: { cwd: workspaceRoot },
          });
          const insertOutcome = yield* memoryRepository.insert({
            memoryId,
            projectId,
            kind: "fact",
            title: "Owned marker memory",
            body: ownedMarker,
            origin: { type: "manual" },
            validUntil: null,
            estimatedTokens: 0,
            now: "2026-08-24T09:12:00.000Z",
          });
          if (insertOutcome.status !== "applied") {
            throw new Error(`expected memory insert to apply, got ${insertOutcome.status}`);
          }
          yield* writeClaudeTranscriptFile({
            claudeHomePath,
            fileName: `${UUID_OWNED}.jsonl`,
            cwd: workspaceRoot,
            sessionId: UUID_OWNED,
            text: insertOutcome.record.body,
            mtimeMs: nowMs - 60_000,
          });
          const deleteOutcome = yield* memoryRepository.delete({
            projectId,
            memoryId,
            expectedVersion: insertOutcome.record.version,
          });
          if (deleteOutcome.status !== "applied") {
            throw new Error(`expected memory delete to apply, got ${deleteOutcome.status}`);
          }
          expect(Option.isNone(yield* memoryRepository.getById({ projectId, memoryId }))).toBe(
            true,
          );
          expect(yield* importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 0,
            skippedCount: 0,
          });
          yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete-owned-thread"),
            threadId: ownedThreadId,
          });
          expect((yield* directory.listBindings()).map((binding) => binding.threadId)).toContain(
            ownedThreadId,
          );
          yield* engine.dispatch({
            type: "project.delete",
            commandId: CommandId.make("delete-owned-project"),
            projectId,
            force: true,
          });
          expect((yield* directory.listBindings()).map((binding) => binding.threadId)).toContain(
            ownedThreadId,
          );
        }),
      );

      yield* phase(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const memoryRepository = yield* ProjectMemoryRepository;
          expect((yield* directory.listBindings()).map((binding) => binding.threadId)).toContain(
            ownedThreadId,
          );
          expect(Option.isNone(yield* memoryRepository.getById({ projectId, memoryId }))).toBe(
            true,
          );
          yield* makeOwnedProject(engine, {
            projectId: recreatedProjectId,
            workspaceRoot,
            label: "owned-delete-recreated",
          });
          yield* writeClaudeTranscriptFile({
            claudeHomePath,
            fileName: `${UUID_UNRELATED}.jsonl`,
            cwd: workspaceRoot,
            sessionId: UUID_UNRELATED,
            text: "Unrelated after deletion",
            mtimeMs: nowMs - 120_000,
          });
          expect(yield* importRecentAgentThreads({ projectId: recreatedProjectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          expect(
            (yield* snapshots.getImportedAgentSessionSources(recreatedProjectId)).map(
              (entry) => entry.source.providerSessionId,
            ),
          ).toEqual([UUID_UNRELATED]);
          expect(
            Option.isNone(
              yield* snapshots.getThreadDetailById(
                ThreadId.make(`import:claudeAgent:${UUID_OWNED}`),
              ),
            ),
          ).toBe(true);
          expect((yield* directory.listBindings()).map((binding) => binding.threadId)).toContain(
            ownedThreadId,
          );
        }),
      );
    }),
  );

  it.effect("blocks a resumed owned session from a changed-body reimport even after deletion", () =>
    Effect.gen(function* () {
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-import-owned-resume-",
      });
      const workspaceRoot = path.join(fixtureDir, "workspace");
      const claudeHomePath = path.join(fixtureDir, "claude");
      const codexHomePath = path.join(fixtureDir, "codex");
      const dbPath = path.join(fixtureDir, "userdata", "state.sqlite");
      yield* fileSystem.makeDirectory(workspaceRoot);
      const transcriptPath = yield* writeClaudeTranscriptFile({
        claudeHomePath,
        fileName: `${UUID_OWNED}.jsonl`,
        cwd: workspaceRoot,
        sessionId: UUID_OWNED,
        text: "Owned history",
        mtimeMs: nowMs - 60_000,
      });
      const settingsLayer = ServerSettingsService.layerTest({
        providers: {
          claudeAgent: { homePath: claudeHomePath },
          codex: { homePath: codexHomePath },
        },
      });
      const phase = runOwnershipPhase(dbPath, settingsLayer);
      const projectId = ProjectId.make("project-owned-resume");
      const importThreadId = ThreadId.make(`import:claudeAgent:${UUID_OWNED}`);

      // Nothing owns the session yet, so the first import lands and its own
      // binding becomes the ownership evidence for every later run.
      const first = yield* phase(
        Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          expect(yield* directory.listBindings()).toEqual([]);
          yield* makeOwnedProject(engine, { projectId, workspaceRoot, label: "owned-resume" });
          return yield* importRecentAgentThreads({ projectId });
        }),
      );
      expect(first).toEqual({ importedCount: 1, skippedCount: 0 });

      yield* phase(
        Effect.gen(function* () {
          const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          // The import's own binding owns the session now; the unchanged
          // validated original keeps the AlreadyImported count, writing nothing.
          expect(yield* importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 1,
            skippedCount: 0,
          });
          const sourcesBefore = yield* snapshots.getImportedAgentSessionSources(projectId);
          expect(sourcesBefore.map((entry) => entry.source.providerSessionId)).toEqual([
            UUID_OWNED,
          ]);
          const threadBefore = Option.getOrThrow(
            yield* snapshots.getThreadDetailById(importThreadId),
          );
          expect(threadBefore.messages.map((message) => message.text)).toEqual([
            "Owned history",
            "Done",
          ]);

          // The app resumes the same native session: the transcript grows by
          // one record, changing the file identity. Its mtime is pinned back
          // under the frozen clock so the recent-window check still admits it.
          yield* fileSystem.writeFileString(
            transcriptPath,
            `${claudeTranscript(workspaceRoot, UUID_OWNED, "Owned history")}${JSON.stringify({
              type: "user",
              cwd: workspaceRoot,
              sessionId: UUID_OWNED,
              timestamp: "2026-08-24T11:00:00.000Z",
              message: { role: "user", content: "Resumed marker" },
            })}\n`,
          );
          yield* fileSystem.utimes(transcriptPath, nowMs / 1_000, nowMs / 1_000);
          expect(yield* importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 0,
            skippedCount: 0,
          });
          expect(yield* snapshots.getImportedAgentSessionSources(projectId)).toEqual(sourcesBefore);
          const threadAfter = Option.getOrThrow(
            yield* snapshots.getThreadDetailById(importThreadId),
          );
          expect(threadAfter.messages.map((message) => message.text)).toEqual([
            "Owned history",
            "Done",
          ]);
        }),
      );

      yield* phase(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          yield* engine.dispatch({
            type: "thread.delete",
            commandId: CommandId.make("delete-resumed-import"),
            threadId: importThreadId,
          });
          expect(Option.isSome(yield* directory.getBinding(importThreadId))).toBe(true);
          expect(yield* importRecentAgentThreads({ projectId })).toEqual({
            importedCount: 0,
            skippedCount: 0,
          });
          // Deletion is no way back in: public detail hides the row, but the
          // tombstoned projection retains the original imported body.
          expect(Option.isNone(yield* snapshots.getThreadDetailById(importThreadId))).toBe(true);
          const sql = yield* SqlClient.SqlClient;
          const threadRows = yield* sql<{ readonly deletedAt: string | null }>`
            SELECT deleted_at AS "deletedAt"
            FROM projection_threads
            WHERE thread_id = ${importThreadId}
          `;
          expect(threadRows).toHaveLength(1);
          expect(threadRows[0]?.deletedAt).not.toBeNull();
          const messageRows = yield* sql<{ readonly text: string }>`
            SELECT text
            FROM projection_thread_messages
            WHERE thread_id = ${importThreadId}
            ORDER BY created_at, message_id
          `;
          expect(messageRows.map((row) => row.text)).toEqual(["Owned history", "Done"]);
        }),
      );
    }),
  );

  it.effect("does not let an owned Codex session block a Claude session with the same id", () =>
    Effect.gen(function* () {
      const nowMs = Date.parse("2026-08-24T12:00:00.000Z");
      yield* TestClock.setTime(nowMs);
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-import-owned-cross-",
      });
      const workspaceRoot = path.join(fixtureDir, "workspace");
      const claudeHomePath = path.join(fixtureDir, "claude");
      const codexHomePath = path.join(fixtureDir, "codex");
      const dbPath = path.join(fixtureDir, "userdata", "state.sqlite");
      yield* fileSystem.makeDirectory(workspaceRoot);
      yield* writeClaudeTranscriptFile({
        claudeHomePath,
        fileName: `${UUID_SHARED}.jsonl`,
        cwd: workspaceRoot,
        sessionId: UUID_SHARED,
        text: "Claude session with a shared id",
        mtimeMs: nowMs - 60_000,
      });
      const rolloutPath = path.join(
        codexHomePath,
        "sessions",
        "2026",
        "08",
        "24",
        `rollout-${UUID_SHARED}.jsonl`,
      );
      yield* fileSystem.makeDirectory(path.dirname(rolloutPath), { recursive: true });
      yield* fileSystem.writeFileString(
        rolloutPath,
        [
          encodeTranscriptRecord({
            type: "session_meta",
            payload: { id: UUID_SHARED, cwd: workspaceRoot },
          }),
          encodeTranscriptRecord({
            type: "event_msg",
            timestamp: "2026-08-24T10:00:00.000Z",
            payload: { type: "user_message", message: "Codex owned prompt" },
          }),
        ].join("\n"),
      );
      yield* fileSystem.utimes(rolloutPath, (nowMs - 30_000) / 1_000, (nowMs - 30_000) / 1_000);
      const settingsLayer = ServerSettingsService.layerTest({
        providers: {
          claudeAgent: { homePath: claudeHomePath },
          codex: { homePath: codexHomePath },
        },
      });
      const phase = runOwnershipPhase(dbPath, settingsLayer);
      const projectId = ProjectId.make("project-owned-cross");

      const first = yield* phase(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngine.OrchestrationEngineService;
          const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
          yield* makeOwnedProject(engine, { projectId, workspaceRoot, label: "owned-cross" });
          // The Codex thread owns the same id string the Claude session
          // carries; exclusion is provider-scoped, so only the Codex rollout
          // is blocked.
          yield* directory.upsert({
            threadId: ThreadId.make("thread-owned-codex"),
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "stopped",
            resumeCursor: { threadId: UUID_SHARED },
            runtimePayload: { cwd: workspaceRoot },
          });
          return yield* importRecentAgentThreads({ projectId });
        }),
      );
      expect(first).toEqual({ importedCount: 1, skippedCount: 0 });

      yield* phase(
        Effect.gen(function* () {
          const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
          const claudeThread = Option.getOrThrow(
            yield* snapshots.getThreadDetailById(
              ThreadId.make(`import:claudeAgent:${UUID_SHARED}`),
            ),
          );
          expect(claudeThread.messages.map((message) => message.text)).toEqual([
            "Claude session with a shared id",
            "Done",
          ]);
          expect(
            Option.isNone(
              yield* snapshots.getThreadDetailById(ThreadId.make(`import:codex:${UUID_SHARED}`)),
            ),
          ).toBe(true);
          expect(
            (yield* snapshots.getImportedAgentSessionSources(projectId)).map((entry) => [
              entry.source.provider,
              entry.source.providerSessionId,
            ]),
          ).toEqual([["claudeAgent", UUID_SHARED]]);
        }),
      );
    }),
  );
});
