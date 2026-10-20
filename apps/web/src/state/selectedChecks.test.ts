import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  SELECTED_CHECK_RECEIPT_KIND,
  selectedCheckReceiptId,
  ThreadId,
  WS_METHODS,
  type AuthSessionState,
  type EnvironmentId as EnvironmentIdType,
  type ProjectId as ProjectIdType,
  type ProjectScript,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type SelectedChecksGetResult,
  type SelectedCheckReceipt,
  type SelectedChecksCancelInput,
  type SelectedChecksResolveOwnershipInput,
  type SelectedChecksRunInput,
  type SelectedChecksRunResult,
  type ServerSettings,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { SelectedChecksTarget } from "@t3tools/client-runtime/state/selected-checks-control";
import {
  AVAILABLE_CONNECTION_STATE,
  EnvironmentNotRegisteredError,
  EnvironmentRegistry,
  EnvironmentSupervisor,
  PrimaryConnectionTarget,
  type ConnectionCatalogEntry,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";
import {
  type EnvironmentRpcInput,
  type EnvironmentRpcSuccess,
  type RpcSession,
} from "@t3tools/client-runtime/rpc";
import {
  createRuntimeCommand,
  runAtomCommand,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { act, createElement, StrictMode, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { Writable } from "effect/unstable/reactivity/Atom";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

import type { SelectedChecksHandle } from "./selectedChecks";

const AUTH_DESCRIPTOR = {
  policy: "unsafe-no-auth",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "t3_session",
} satisfies AuthSessionState["auth"];

function sessionWithScopes(
  scopes: ReadonlyArray<typeof AuthOrchestrationOperateScope | typeof AuthOrchestrationReadScope>,
): AuthSessionState {
  return {
    authenticated: true,
    auth: AUTH_DESCRIPTOR,
    scopes: [...scopes],
    sessionMethod: "bearer-access-token",
  };
}

const OPERATE_SESSION = sessionWithScopes([
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
]);
const READ_ONLY_SESSION = sessionWithScopes([AuthOrchestrationReadScope]);

function projectScript(
  id: string,
  command: string,
  icon: ProjectScript["icon"] = "lint",
): ProjectScript {
  return { id, name: id, command, icon, runOnWorktreeCreate: false };
}

type SelectedChecksRpcMethod =
  | typeof WS_METHODS.selectedChecksGet
  | typeof WS_METHODS.selectedChecksRun
  | typeof WS_METHODS.selectedChecksCancel
  | typeof WS_METHODS.selectedChecksResolveOwnership;

type SelectedChecksRpcClient = {
  readonly [Tag in SelectedChecksRpcMethod]: (
    input: EnvironmentRpcInput<Tag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<Tag>>;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

type GetPending = {
  readonly ordinal: number;
  readonly threadId: string;
  readonly deferred: Deferred<SelectedChecksGetResult>;
};

type GetLedger = {
  entered: number;
  settled: number;
  pending: Array<GetPending>;
};

type GetCallRecord = {
  readonly threadId: string;
  readonly ordinal: number;
};

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const emptyGetResult = (): SelectedChecksGetResult => ({
  capability: { available: true, reason: null },
  record: { kind: "none" },
  changedScriptIds: [],
  admission: { state: "open" },
});

const digestHex = (seed: string) => seed.repeat(64);

const STALE_ADMISSION_SHA = digestHex("a");
const FRESH_ADMISSION_SHA = digestHex("b");

function ownerUnresolvedAdmission(sha256: string, forThread: ThreadIdType = threadId) {
  return {
    state: "owner-unresolved" as const,
    marker: {
      sha256,
      threadId: forThread,
      attemptId: "attempt-x",
      scriptId: null,
      pgid: null,
      writtenAt: "2026-10-01T00:00:00.000Z",
    },
  };
}

function getWithAdmission(
  sha256: string,
  forThread: ThreadIdType = threadId,
): SelectedChecksGetResult {
  return {
    ...emptyGetResult(),
    admission: ownerUnresolvedAdmission(sha256, forThread),
  };
}

function observableAdmissionDigest(): string | null {
  const admission = latest.view.admission;
  if (admission === null) return null;
  if (admission.state === "owner-unresolved" || admission.state === "owner-corrupt") {
    return admission.marker.sha256;
  }
  return null;
}

function expectAdmissionDigestNot(staleSha: string) {
  expect(observableAdmissionDigest()).not.toBe(staleSha);
}

function expectAdmissionDigest(staleSha: string) {
  expect(observableAdmissionDigest()).toBe(staleSha);
}

function makePassingReceipt(
  overrides: Partial<SelectedCheckReceipt> & { readonly threadId?: ThreadIdType } = {},
): SelectedCheckReceipt {
  const receiptThread = overrides.threadId ?? threadId;
  const sha = digestHex("c");
  return {
    schemaVersion: 1,
    attemptId: "run-attempt-1",
    revision: 2,
    threadAnchorSequence: 5,
    context: {
      projectId,
      workspaceRoot: "/workspace",
      worktreePath: "/worktree",
      cwd: "/workspace",
      shell: "/bin/zsh",
      envSha256: sha,
    },
    planned: [
      {
        scriptId: "lint",
        scriptName: "Lint",
        commandSha256: sha,
        timeoutMs: 60_000,
      },
    ],
    environment: {
      environmentId,
      platform: "darwin",
      arch: "arm64",
      osRelease: "25.6.0",
      serverVersion: "1.0.0",
      nodeVersion: "22.11.0",
    },
    tree: {
      atStart: { kind: "complete", treeOid: "d".repeat(40) },
      atEnd: { kind: "complete", treeOid: "d".repeat(40) },
      repoAtStart: { topLevel: "/workspace", commonDir: "/workspace" },
      repoAtEnd: { topLevel: "/workspace", commonDir: "/workspace" },
    },
    phase: "completed",
    checks: [
      {
        scriptId: "lint",
        status: "passed",
        startedAt: "2026-10-01T00:00:00.000Z",
        endedAt: "2026-10-01T00:00:30.000Z",
        exitCode: 0,
        exitedBy: "exit",
        exitSignal: null,
        pgid: 41234,
        group: "empty",
        stdout: { bytes: 120, sha256: sha },
        stderr: { bytes: 0, sha256: digestHex("d") },
        failure: null,
      },
    ],
    startedAt: "2026-10-01T00:00:00.000Z",
    endedAt: "2026-10-01T00:01:00.000Z",
    error: null,
    ...overrides,
    threadId: receiptThread,
  };
}

function presentRunningGet(attemptId = "run-attempt-1"): SelectedChecksGetResult {
  const receipt = makePassingReceipt({ attemptId, phase: "running" });
  return {
    ...emptyGetResult(),
    record: { kind: "present", receipt, sequence: 3 },
    admission: { state: "open" },
  };
}

// Sequence must reach the receipt's anchor (5) for deriveSelectedCheckState
// to hold "all-selected-passed".
function presentPassedGet(
  overrides: { attemptId?: string; revision?: number; sequence?: number } = {},
): SelectedChecksGetResult {
  const receipt = makePassingReceipt({
    attemptId: overrides.attemptId ?? "run-attempt-1",
    revision: overrides.revision ?? 2,
  });
  return {
    ...emptyGetResult(),
    record: { kind: "present", receipt, sequence: overrides.sequence ?? 7 },
    admission: { state: "open" },
  };
}

type TestBag = {
  readonly environmentId: EnvironmentIdType;
  readonly threadId: ThreadIdType;
  readonly projectId: ProjectIdType;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly flushRegistry: () => void;
  readonly catalogValueAtom: Writable<{
    isReady: boolean;
    entries: Map<EnvironmentIdType, ConnectionCatalogEntry>;
  }>;
  readonly catalogEntry: ConnectionCatalogEntry;
  readonly prepared: PreparedConnection;
  readonly preparedAtom: Writable<Option.Option<PreparedConnection>>;
  readonly projectAtom: Writable<EnvironmentProject | null>;
  readonly shellAtom: Writable<EnvironmentThreadShell | null>;
  readonly detailAtom: Writable<EnvironmentThread | null>;
  readonly statusAtom: Writable<EnvironmentThreadStatus>;
  readonly emptyProjectAtom: Writable<EnvironmentProject | null>;
  readonly emptyShellAtom: Writable<EnvironmentThreadShell | null>;
  readonly emptyDetailAtom: Writable<EnvironmentThread | null>;
  readonly emptyPreparedAtom: Writable<Option.Option<PreparedConnection>>;
  readonly settingsAtom: Writable<ServerSettings>;
  readonly connectionStateAtom: Writable<AsyncResult.AsyncResult<SupervisorConnectionState>>;
  readonly testRuntime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient, never>;
  readonly fixture: {
    readonly resetService: AtomCommand<void, void, never>;
    readonly setConnectionGeneration: AtomCommand<{ readonly generation: number }, void, never>;
    readonly readServiceEntry: AtomCommand<void, ConnectionCatalogEntry | undefined, never>;
    readonly replaceServiceEntry: AtomCommand<
      { readonly entry: ConnectionCatalogEntry },
      void,
      never
    >;
  };
  readonly runFixtureCommand: <W, A, E>(command: AtomCommand<W, A, E>, input: W) => Promise<A>;
  readonly replaceServiceEntryEffect: (
    entry: ConnectionCatalogEntry,
  ) => Effect.Effect<void, never, EnvironmentRegistry>;
  readonly getLedger: GetLedger;
  readonly resolveGetOrdinal: (ordinal: number, result: SelectedChecksGetResult) => void;
  readonly resolveAllPendingGets: (result?: SelectedChecksGetResult) => void;
  readonly drainScheduler: () => void;
  readonly setConnectionGeneration: (generation: number) => Promise<void>;
  readonly replaceCatalogEntry: (entry: ConnectionCatalogEntry) => void;
  readonly resetForTest: () => Promise<void>;
  readonly readServiceEntry: () => Promise<ConnectionCatalogEntry | undefined>;
  readonly makeRpcSession: (client: SelectedChecksRpcClient) => RpcSession;
  readonly swapRpcSession: (client: SelectedChecksRpcClient) => Effect.Effect<void>;
  readonly interruptNextGet: { current: boolean };
  readonly armRunGate: () => Deferred<SelectedChecksRunResult>;
};

function buildTestBag(
  authFetch: ReturnType<
    typeof vi.fn<() => Effect.Effect<AuthSessionState, unknown, EnvironmentRegistry>>
  >,
  getCalls: Array<GetCallRecord>,
  runCalls: Array<SelectedChecksRunInput>,
  resolveCalls: Array<SelectedChecksResolveOwnershipInput>,
  cancelCalls: Array<SelectedChecksCancelInput>,
): TestBag {
  const environmentId = EnvironmentId.make("env-selected-checks");
  const threadId = ThreadId.make("thread-selected-checks");
  const projectId = ProjectId.make("project-1");

  const taskQueue: Array<{ readonly run: () => void; canceled: boolean }> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      const entry = { run: task, canceled: false };
      taskQueue.push(entry);
      return () => {
        entry.canceled = true;
      };
    },
  });
  const flushRegistry = () => {
    for (let entry = taskQueue.shift(); entry !== undefined; entry = taskQueue.shift()) {
      if (!entry.canceled) entry.run();
    }
  };
  const drainScheduler = () => {
    for (const entry of taskQueue) entry.canceled = true;
    taskQueue.length = 0;
  };

  const getLedger: GetLedger = { entered: 0, settled: 0, pending: [] };

  const resolveGetOrdinal = (ordinal: number, result: SelectedChecksGetResult) => {
    const pending = getLedger.pending.find((entry) => entry.ordinal === ordinal);
    if (pending === undefined) return;
    pending.deferred.resolve(result);
    getLedger.settled += 1;
    getLedger.pending = getLedger.pending.filter((entry) => entry.ordinal !== ordinal);
  };

  const resolveAllPendingGets = (result: SelectedChecksGetResult = emptyGetResult()) => {
    for (const pending of [...getLedger.pending]) {
      resolveGetOrdinal(pending.ordinal, result);
    }
  };

  const catalogEntry: ConnectionCatalogEntry = {
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test",
      httpBaseUrl: "https://checks.test",
      wsBaseUrl: "wss://checks.test",
    }),
    profile: Option.none(),
    enabled: true,
  };

  const catalogState = {
    isReady: true,
    entries: new Map<EnvironmentIdType, ConnectionCatalogEntry>([[environmentId, catalogEntry]]),
  };
  const catalogValueAtom = Atom.make(catalogState).pipe(Atom.keepAlive);

  const connectedState = (generation = 1): SupervisorConnectionState => ({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online" as NetworkStatus,
    phase: "connected",
    attempt: 1,
    generation,
  });

  const connectionStateAtom = Atom.make<AsyncResult.AsyncResult<SupervisorConnectionState, never>>(
    AsyncResult.success(connectedState()),
  ).pipe(Atom.keepAlive);

  const prepared: PreparedConnection = {
    environmentId,
    label: "Test",
    httpBaseUrl: "https://checks.test",
    socketUrl: "wss://checks.test",
    httpAuthorization: null,
    target: catalogEntry.target,
  };
  const preparedAtom = Atom.make(Option.some(prepared)).pipe(Atom.keepAlive);
  const projectAtom = Atom.make<EnvironmentProject | null>(null).pipe(Atom.keepAlive);
  const shellAtom = Atom.make<EnvironmentThreadShell | null>(null).pipe(Atom.keepAlive);
  const detailAtom = Atom.make<EnvironmentThread | null>(null).pipe(Atom.keepAlive);
  const statusAtom = Atom.make<EnvironmentThreadStatus>("live").pipe(Atom.keepAlive);
  const emptyProjectAtom = Atom.make<EnvironmentProject | null>(null).pipe(Atom.keepAlive);
  const emptyShellAtom = Atom.make<EnvironmentThreadShell | null>(null).pipe(Atom.keepAlive);
  const emptyDetailAtom = Atom.make<EnvironmentThread | null>(null).pipe(Atom.keepAlive);
  const emptyPreparedAtom = Atom.make(Option.none<PreparedConnection>()).pipe(Atom.keepAlive);
  const settingsAtom = Atom.make(DEFAULT_SERVER_SETTINGS).pipe(Atom.keepAlive);

  const interruptNextGet = { current: false };
  const runGate: { deferred: Deferred<SelectedChecksRunResult> | null } = { deferred: null };

  const armRunGate = (): Deferred<SelectedChecksRunResult> => {
    const deferred = makeDeferred<SelectedChecksRunResult>();
    runGate.deferred = deferred;
    return deferred;
  };

  const getClient: SelectedChecksRpcClient = {
    [WS_METHODS.selectedChecksGet]: (input) => {
      const ordinal = ++getLedger.entered;
      getCalls.push({ threadId: input.threadId, ordinal });
      if (interruptNextGet.current) {
        interruptNextGet.current = false;
        return Effect.interrupt.pipe(
          Effect.ensuring(
            Effect.sync(() => {
              getLedger.settled += 1;
            }),
          ),
        );
      }
      const deferred = makeDeferred<SelectedChecksGetResult>();
      getLedger.pending.push({ ordinal, threadId: input.threadId, deferred });
      return Effect.promise(() => deferred.promise);
    },
    [WS_METHODS.selectedChecksRun]: (input) =>
      Effect.sync(() => {
        runCalls.push({
          threadId: input.threadId,
          scriptIds: [...input.scriptIds],
        });
      }).pipe(
        Effect.flatMap(() => {
          const gate = runGate.deferred;
          if (gate !== null) {
            return Effect.promise(() => gate.promise);
          }
          return Effect.succeed({ attemptId: "attempt-1" });
        }),
      ),
    [WS_METHODS.selectedChecksCancel]: (input) =>
      Effect.sync(() => {
        cancelCalls.push({ threadId: input.threadId, attemptId: input.attemptId });
        return { cancelled: true };
      }),
    [WS_METHODS.selectedChecksResolveOwnership]: (input) =>
      Effect.sync(() => {
        resolveCalls.push({
          markerSha256: input.markerSha256,
          acknowledgeUncertainty: input.acknowledgeUncertainty,
        });
        return { outcome: "acknowledged", admission: { state: "open" } };
      }),
  };

  const makeRpcSession = (client: SelectedChecksRpcClient): RpcSession => ({
    client: client as unknown as RpcSession["client"],
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  });

  const supervisors = new Map<EnvironmentIdType, EnvironmentSupervisor["Service"]>();

  const ensureSupervisor = Effect.gen(function* () {
    const existing = supervisors.get(environmentId);
    if (existing !== undefined) return existing;
    const supervisor = EnvironmentSupervisor.of({
      target: catalogEntry.target,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>(connectedState()),
      session: yield* SubscriptionRef.make(Option.some(makeRpcSession(getClient))),
      prepared: yield* SubscriptionRef.make(Option.some(prepared)),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor["Service"]);
    supervisors.set(environmentId, supervisor);
    return supervisor;
  });

  const acquireSupervisor = (
    id: EnvironmentIdType,
  ): Effect.Effect<EnvironmentSupervisor["Service"], EnvironmentNotRegisteredError> =>
    id !== environmentId
      ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId: id }))
      : ensureSupervisor;

  const run: EnvironmentRegistry["Service"]["run"] = (id, effect) =>
    Effect.gen(function* () {
      const supervisor = yield* acquireSupervisor(id);
      return yield* Effect.provideService(effect, EnvironmentSupervisor, supervisor);
    });

  const runStream: EnvironmentRegistry["Service"]["runStream"] = (id, stream) =>
    Stream.unwrap(
      acquireSupervisor(id).pipe(
        Effect.map((supervisor) =>
          Stream.provideService(stream, EnvironmentSupervisor, supervisor),
        ),
      ),
    );

  const followStream: EnvironmentRegistry["Service"]["followStream"] = (id, stream) =>
    id !== environmentId
      ? Stream.empty
      : Stream.unwrap(
          ensureSupervisor.pipe(
            Effect.map((supervisor) =>
              Stream.provideService(stream, EnvironmentSupervisor, supervisor),
            ),
          ),
        );

  const registryLayer = Layer.effect(
    EnvironmentRegistry,
    Effect.gen(function* () {
      const entries = yield* SubscriptionRef.make<
        ReadonlyMap<EnvironmentIdType, ConnectionCatalogEntry>
      >(new Map([[environmentId, catalogEntry]]));
      const networkStatus = yield* SubscriptionRef.make<NetworkStatus>("online");
      return EnvironmentRegistry.of({
        entries,
        networkStatus,
        start: Effect.void,
        register: () => Effect.void,
        registerPlatform: () => Effect.void,
        reconcilePlatform: () => Effect.void,
        remove: (id) => Effect.fail(new EnvironmentNotRegisteredError({ environmentId: id })),
        removeRelayEnvironments: () => Effect.void,
        retryNow: () => Effect.void,
        setEnabled: () => Effect.void,
        setCompatibility: () => Effect.void,
        state: (id) =>
          id !== environmentId
            ? Effect.fail(new EnvironmentNotRegisteredError({ environmentId: id }))
            : Effect.succeed(connectedState()),
        stateChanges: (id) =>
          id !== environmentId
            ? Stream.fail(new EnvironmentNotRegisteredError({ environmentId: id }))
            : Stream.empty,
        run,
        runStream,
        followStream,
      });
    }),
  );

  const testRuntime = Atom.runtime(
    Layer.mergeAll(
      registryLayer,
      remoteHttpClientLayer(() =>
        Promise.reject(new Error("Unexpected HttpClient fetch in selected-checks tests.")),
      ),
    ),
  );

  const replaceServiceEntryEffect = (entry: ConnectionCatalogEntry) =>
    Effect.gen(function* () {
      const envReg = yield* EnvironmentRegistry;
      yield* SubscriptionRef.set(
        envReg.entries,
        new Map<EnvironmentIdType, ConnectionCatalogEntry>([[environmentId, entry]]),
      );
    });

  const resetFixtureServiceCommand = createRuntimeCommand(testRuntime, {
    label: "selected-checks-test.reset-fixture-service",
    execute: (_void, registry) =>
      Effect.gen(function* () {
        supervisors.clear();
        const envReg = yield* EnvironmentRegistry;
        yield* SubscriptionRef.set(
          envReg.entries,
          new Map<EnvironmentIdType, ConnectionCatalogEntry>([[environmentId, catalogEntry]]),
        );
        registry.set(connectionStateAtom, AsyncResult.success(connectedState()));
        registry.set(preparedAtom, Option.some(prepared));
        registry.set(projectAtom, null);
        registry.set(shellAtom, null);
        registry.set(detailAtom, null);
        registry.set(statusAtom, "live");
        registry.set(settingsAtom, DEFAULT_SERVER_SETTINGS);
      }),
  });

  const setConnectionGenerationCommand = createRuntimeCommand(testRuntime, {
    label: "selected-checks-test.set-connection-generation",
    execute: ({ generation }: { readonly generation: number }, registry) =>
      Effect.gen(function* () {
        registry.set(connectionStateAtom, AsyncResult.success(connectedState(generation)));
        const supervisor = yield* ensureSupervisor;
        yield* SubscriptionRef.update(supervisor.state, (state) => ({
          ...state,
          generation,
          phase: "connected" as const,
        }));
      }),
  });

  const readServiceEntryCommand = createRuntimeCommand(testRuntime, {
    label: "selected-checks-test.read-service-entry",
    execute: (_void, _registry) =>
      Effect.gen(function* () {
        const envReg = yield* EnvironmentRegistry;
        const map = yield* SubscriptionRef.get(envReg.entries);
        return map.get(environmentId);
      }),
  });

  const replaceServiceEntryCommand = createRuntimeCommand(testRuntime, {
    label: "selected-checks-test.replace-service-entry",
    execute: ({ entry }: { readonly entry: ConnectionCatalogEntry }) =>
      replaceServiceEntryEffect(entry),
  });

  const runFixtureCommand = async <W, A, E>(
    command: AtomCommand<W, A, E>,
    input: W,
  ): Promise<A> => {
    const result = await runAtomCommand(registry, command, input, {
      reportFailure: false,
      reportDefect: false,
    });
    if (result._tag !== "Success") {
      throw new Error(`Fixture command ${command.label} failed`);
    }
    return result.value;
  };

  const syncCatalogAtom = () => {
    registry.set(catalogValueAtom, {
      isReady: true,
      entries: new Map([[environmentId, catalogEntry]]),
    });
    flushRegistry();
  };

  const replaceCatalogEntry = (entry: ConnectionCatalogEntry) => {
    catalogState.entries.set(environmentId, entry);
    registry.set(catalogValueAtom, {
      isReady: true,
      entries: new Map(catalogState.entries),
    });
    flushRegistry();
  };

  const setConnectionGeneration = async (generation: number) => {
    await runFixtureCommand(setConnectionGenerationCommand, { generation });
    flushRegistry();
  };

  const readServiceEntry = () => runFixtureCommand(readServiceEntryCommand, undefined);

  const swapRpcSession = (client: SelectedChecksRpcClient) =>
    Effect.gen(function* () {
      const sup = yield* ensureSupervisor;
      yield* SubscriptionRef.set(sup.session, Option.some(makeRpcSession(client)));
    });

  const resetForTest = async () => {
    if (runGate.deferred !== null) {
      runGate.deferred.resolve({ attemptId: "attempt-1" });
      runGate.deferred = null;
    }
    resolveAllPendingGets();
    drainScheduler();
    getCalls.length = 0;
    runCalls.length = 0;
    resolveCalls.length = 0;
    cancelCalls.length = 0;
    interruptNextGet.current = false;
    getLedger.entered = 0;
    getLedger.settled = 0;
    getLedger.pending.length = 0;
    catalogState.entries.set(environmentId, catalogEntry);
    await runFixtureCommand(resetFixtureServiceCommand, undefined);
    syncCatalogAtom();
    flushRegistry();
    authFetch.mockReset();
    authFetch.mockImplementation(() => Effect.succeed(OPERATE_SESSION));
  };

  syncCatalogAtom();
  registry.set(preparedAtom, Option.some(prepared));
  registry.set(settingsAtom, DEFAULT_SERVER_SETTINGS);
  flushRegistry();

  return {
    environmentId,
    threadId,
    projectId,
    registry,
    flushRegistry,
    catalogValueAtom,
    catalogEntry,
    prepared,
    preparedAtom,
    projectAtom,
    shellAtom,
    detailAtom,
    statusAtom,
    emptyProjectAtom,
    emptyShellAtom,
    emptyDetailAtom,
    emptyPreparedAtom,
    settingsAtom,
    connectionStateAtom,
    testRuntime,
    fixture: {
      resetService: resetFixtureServiceCommand,
      setConnectionGeneration: setConnectionGenerationCommand,
      readServiceEntry: readServiceEntryCommand,
      replaceServiceEntry: replaceServiceEntryCommand,
    },
    runFixtureCommand,
    replaceServiceEntryEffect,
    getLedger,
    resolveGetOrdinal,
    resolveAllPendingGets,
    drainScheduler,
    setConnectionGeneration,
    replaceCatalogEntry,
    resetForTest,
    readServiceEntry,
    makeRpcSession,
    swapRpcSession,
    interruptNextGet,
    armRunGate,
  };
}

/** The mocked session read fails with this, as the real read fails with a tagged error. */
class AuthFetchError extends Data.TaggedError("AuthFetchError")<{ readonly cause: unknown }> {}

const root = vi.hoisted(() => {
  const authFetch =
    vi.fn<() => Effect.Effect<AuthSessionState, AuthFetchError, EnvironmentRegistry>>();
  const getCalls: Array<GetCallRecord> = [];
  const runCalls: Array<SelectedChecksRunInput> = [];
  const resolveCalls: Array<SelectedChecksResolveOwnershipInput> = [];
  const cancelCalls: Array<SelectedChecksCancelInput> = [];
  let bag: TestBag | undefined;
  return {
    authFetch,
    getCalls,
    runCalls,
    resolveCalls,
    cancelCalls,
    getBag: async () => {
      bag ??= buildTestBag(authFetch, getCalls, runCalls, resolveCalls, cancelCalls);
      return bag;
    },
  };
});

vi.mock("../connection/runtime", async () => ({
  connectionAtomRuntime: (await root.getBag()).testRuntime,
}));

vi.mock("../connection/catalog", async () => {
  const bag = await root.getBag();
  return {
    environmentCatalog: {
      catalogValueAtom: bag.catalogValueAtom,
      stateAtom: () => bag.connectionStateAtom,
    },
  };
});

vi.mock("./session", async (importOriginal) => {
  const original = await importOriginal<typeof import("./session")>();
  const bag = await root.getBag();
  return {
    ...original,
    environmentSession: {
      ...original.environmentSession,
      preparedConnectionValueAtom: (id: EnvironmentIdType) =>
        id === bag.environmentId ? bag.preparedAtom : bag.emptyPreparedAtom,
    },
    usePreparedConnection: (id: EnvironmentIdType | null) =>
      useAtomValue(id === bag.environmentId ? bag.preparedAtom : bag.emptyPreparedAtom),
  };
});

vi.mock("./entities", async (importOriginal) => {
  const original = await importOriginal<typeof import("./entities")>();
  const bag = await root.getBag();
  const matchesProject = (ref: ScopedProjectRef) =>
    ref.environmentId === bag.environmentId && ref.projectId === bag.projectId;
  const matchesEnvironmentThread = (ref: ScopedThreadRef) =>
    ref.environmentId === bag.environmentId;
  return {
    ...original,
    useProject: (ref: ScopedProjectRef | null) =>
      useAtomValue(ref !== null && matchesProject(ref) ? bag.projectAtom : bag.emptyProjectAtom),
    useThreadShell: (ref: ScopedThreadRef | null) =>
      useAtomValue(
        ref !== null && matchesEnvironmentThread(ref) ? bag.shellAtom : bag.emptyShellAtom,
      ),
    useThreadDetail: (ref: ScopedThreadRef | null) =>
      useAtomValue(
        ref !== null && matchesEnvironmentThread(ref) ? bag.detailAtom : bag.emptyDetailAtom,
      ),
  };
});

vi.mock("./projects", async (importOriginal) => {
  const original = await importOriginal<typeof import("./projects")>();
  const bag = await root.getBag();
  return {
    ...original,
    environmentProjects: {
      ...original.environmentProjects,
      projectAtom: (ref: ScopedProjectRef) =>
        ref.environmentId === bag.environmentId && ref.projectId === bag.projectId
          ? bag.projectAtom
          : original.environmentProjects.projectAtom(ref),
    },
  };
});

vi.mock("./server", async (importOriginal) => {
  const original = await importOriginal<typeof import("./server")>();
  const bag = await root.getBag();
  return {
    ...original,
    serverEnvironment: {
      ...original.serverEnvironment,
      settingsValueAtom: (id: EnvironmentIdType) =>
        id === bag.environmentId
          ? bag.settingsAtom
          : original.serverEnvironment.settingsValueAtom(id),
    },
  };
});

vi.mock("./threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("./threads")>();
  const bag = await root.getBag();
  return {
    ...original,
    environmentThreadShells: {
      ...original.environmentThreadShells,
      threadShellAtom: (ref: ScopedThreadRef) =>
        ref.environmentId === bag.environmentId
          ? bag.shellAtom
          : original.environmentThreadShells.threadShellAtom(ref),
    },
    environmentThreadDetails: {
      ...original.environmentThreadDetails,
      detailAtom: (ref: ScopedThreadRef) =>
        ref.environmentId === bag.environmentId
          ? bag.detailAtom
          : original.environmentThreadDetails.detailAtom(ref),
      statusAtom: (ref: ScopedThreadRef) =>
        ref.environmentId === bag.environmentId
          ? bag.statusAtom
          : original.environmentThreadDetails.statusAtom(ref),
    },
  };
});

vi.mock("@t3tools/client-runtime/state/session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@t3tools/client-runtime/state/session")>();
  await root.getBag();
  return {
    ...original,
    fetchEnvironmentSessionState: () => root.authFetch(),
  };
});

import {
  createSelectedChecksSessionConfirmation,
  deriveSelectedChecksPermission,
  selectedChecksEnvironment,
  selectedChecksLifecycleKey,
  useSelectedChecks,
  type SelectedChecksAuthStamp,
  type SelectedChecksConfirmation,
  type SelectedChecksCurrentSource,
  type SelectedChecksRecordIdentity,
} from "./selectedChecks";

let bag!: TestBag;
let environmentId!: EnvironmentIdType;
let threadId!: ThreadIdType;
let projectId!: ProjectIdType;

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

function makeShell(overrides: Partial<EnvironmentThreadShell> = {}): EnvironmentThreadShell {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: "/worktree",
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    pinOrderKey: null,
    pinnedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function makeProject(
  workspaceRoot = "/workspace",
  scripts: ReadonlyArray<ProjectScript> = [
    projectScript("lint", "pnpm lint"),
    projectScript("test", "pnpm test", "test"),
  ],
): EnvironmentProject {
  return {
    environmentId,
    id: projectId,
    title: "Project",
    workspaceRoot,
    defaultModelSelection: null,
    scripts: [...scripts],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

function makeThreadDetail(): EnvironmentThread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection,
    activities: [],
    messages: [],
    proposedPlans: [],
    checkpoints: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    worktreePath: "/worktree",
    branch: null,
    latestTurn: null,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    deletedAt: null,
    runtimeMode: "full-access",
    interactionMode: "default",
    pullRequests: [],
    session: null,
  };
}

function liveReceiptActivity(
  receipt: SelectedCheckReceipt,
  sequence: number,
): EnvironmentThread["activities"][number] {
  return {
    id: EventId.make(selectedCheckReceiptId(threadId)),
    tone: "info",
    kind: SELECTED_CHECK_RECEIPT_KIND,
    summary: "selected checks",
    payload: receipt,
    turnId: null,
    sequence,
    createdAt: "2026-10-01T00:02:00.000Z",
  };
}

function stampFor(
  entry: object,
  generation: number,
  prepared: PreparedConnection,
): SelectedChecksAuthStamp {
  return { entryId: 1, generation, preparedId: 2, prepared };
}

function confirmationTarget(overrides: { threadId?: ThreadIdType } = {}): SelectedChecksTarget {
  return { environmentId, threadId: overrides.threadId ?? threadId };
}

let renderer: ReactTestRenderer | undefined;
let latest: SelectedChecksHandle;
let pendingAuth: Deferred<AuthSessionState> | null = null;
let domListeners: { focus: () => void; visibility: () => void; teardown: () => void };

function Probe(input: {
  project: EnvironmentProject | null;
  candidates: ReadonlyArray<ProjectScript>;
  threadId?: ThreadIdType;
}) {
  const handle = useSelectedChecks({
    environmentId,
    threadId: input.threadId ?? threadId,
    project: input.project,
    candidates: input.candidates,
  });
  useLayoutEffect(() => {
    latest = handle;
  }, [handle]);
  return null;
}

function mountStrict(
  project: EnvironmentProject | null = makeProject(),
  candidates: ReadonlyArray<ProjectScript> = project?.scripts ?? [],
) {
  renderer = create(
    createElement(
      RegistryContext.Provider,
      { value: bag.registry },
      createElement(StrictMode, null, createElement(Probe, { project, candidates })),
    ),
  );
}

function stubDom() {
  const listeners = new Map<string, Set<() => void>>();
  const add = (type: string, handler: () => void) => {
    const set = listeners.get(type) ?? new Set();
    set.add(handler);
    listeners.set(type, set);
  };
  const remove = (type: string, handler: () => void) => {
    listeners.get(type)?.delete(handler);
  };
  vi.stubGlobal("window", {
    addEventListener: add,
    removeEventListener: remove,
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: add,
    removeEventListener: remove,
  });
  return {
    focus: () => listeners.get("focus")?.forEach((handler) => handler()),
    visibility: () => listeners.get("visibilitychange")?.forEach((handler) => handler()),
    teardown: () => listeners.clear(),
  };
}

function queueAuth(): Deferred<AuthSessionState> {
  const deferred = makeDeferred<AuthSessionState>();
  pendingAuth = deferred;
  root.authFetch.mockImplementation(() =>
    Effect.tryPromise({
      try: () => deferred.promise,
      catch: (cause) => new AuthFetchError({ cause }),
    }),
  );
  return deferred;
}

async function flushUntil(predicate: () => boolean, budget = 48) {
  for (let step = 0; step < budget; step++) {
    await act(async () => {
      bag.flushRegistry();
    });
    if (predicate()) return;
  }
  throw new Error("Condition not met within controlled registry flush budget");
}

async function waitForGetEntered(count: number) {
  await flushUntil(() => bag.getLedger.entered >= count);
}

async function drainHarness() {
  await act(async () => {
    bag.resolveAllPendingGets();
    bag.drainScheduler();
    bag.flushRegistry();
  });
}

async function resolveAuth(session: AuthSessionState = OPERATE_SESSION) {
  if (pendingAuth === null) throw new Error("queueAuth() before resolveAuth()");
  pendingAuth.resolve(session);
  await flushUntil(
    () => latest.permissionStatus === "confirmed" || latest.permissionStatus === "failed",
  );
}

async function mountConfirmed() {
  seedRegistry();
  await bag.setConnectionGeneration(1);
  queueAuth();
  await act(async () => {
    mountStrict();
    bag.flushRegistry();
  });
  await resolveAuth();
}

async function releaseGetOrdinal(
  ordinal: number,
  result: SelectedChecksGetResult,
  options: { waitForIdle?: boolean } = {},
) {
  const settledBefore = bag.getLedger.settled;
  await act(async () => {
    bag.resolveGetOrdinal(ordinal, result);
    bag.flushRegistry();
  });
  await flushUntil(() => bag.getLedger.settled > settledBefore);
  if (options.waitForIdle === true && latest?.view.open) {
    await flushUntil(() => !latest.view.getInFlight);
  }
}

function observeSelectedChecksRunCommand() {
  const realRun = selectedChecksEnvironment.run.run.bind(selectedChecksEnvironment.run);
  let commandPromise: ReturnType<typeof realRun> | undefined;
  const spy = vi
    .spyOn(selectedChecksEnvironment.run, "run")
    .mockImplementation((registry, input) => {
      commandPromise = realRun(registry, input);
      return commandPromise;
    });
  return {
    commandPromise: () => commandPromise,
    restore: () => spy.mockRestore(),
  };
}

async function settleGet(result: SelectedChecksGetResult = emptyGetResult(), ordinal?: number) {
  const target =
    ordinal !== undefined
      ? bag.getLedger.pending.find((entry) => entry.ordinal === ordinal)
      : bag.getLedger.pending[0];
  if (target === undefined) {
    throw new Error("settleGet called with no pending selected-checks get");
  }
  await releaseGetOrdinal(target.ordinal, result, { waitForIdle: true });
}

function seedRegistry(project: EnvironmentProject = makeProject()) {
  bag.registry.set(bag.projectAtom, project);
  bag.registry.set(bag.shellAtom, makeShell());
  bag.registry.set(bag.detailAtom, makeThreadDetail());
  bag.registry.set(bag.statusAtom, "live");
  bag.flushRegistry();
}

function settingsWithProjectScripts(
  forProjectId: ProjectIdType,
  scripts: ReadonlyArray<ProjectScript>,
): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    projectSettingsOverrides: {
      [forProjectId]: { defaultProjectScripts: [...scripts] },
    },
  };
}

async function remountWithProjectAndCandidates(
  project: EnvironmentProject,
  candidates: ReadonlyArray<ProjectScript>,
) {
  await act(() => renderer?.unmount());
  await act(async () => {
    mountStrict(project, candidates);
    bag.flushRegistry();
  });
}

beforeEach(async () => {
  bag = await root.getBag();
  await bag.resetForTest();
  environmentId = bag.environmentId;
  threadId = bag.threadId;
  projectId = bag.projectId;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  domListeners = stubDom();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  await drainHarness();
  domListeners.teardown();
  vi.unstubAllGlobals();
});

describe("deriveSelectedChecksPermission", () => {
  const stamp = () => stampFor(bag.catalogEntry, 1, bag.prepared);

  it("allows operate only for a matching confirmed session with explicit operate scope", () => {
    const s = stamp();
    const confirmation: SelectedChecksConfirmation = {
      stamp: s,
      status: "confirmed",
      session: OPERATE_SESSION,
      attempt: 1,
      target: confirmationTarget(),
    };
    expect(deriveSelectedChecksPermission(s, confirmation)).toEqual({
      permission: "allowed",
      scopes: [AuthOrchestrationOperateScope, AuthOrchestrationReadScope].sort(),
      status: "confirmed",
    });
  });

  it("treats authenticated without operate scope as read-only", () => {
    const s = stamp();
    const confirmation: SelectedChecksConfirmation = {
      stamp: s,
      status: "confirmed",
      session: READ_ONLY_SESSION,
      attempt: 1,
      target: confirmationTarget(),
    };
    expect(deriveSelectedChecksPermission(s, confirmation).permission).toBe("read-only");
  });

  it("denies mutations when scopes are omitted", () => {
    const s = stamp();
    const confirmation: SelectedChecksConfirmation = {
      stamp: s,
      status: "confirmed",
      session: { authenticated: true, auth: AUTH_DESCRIPTOR },
      attempt: 1,
      target: confirmationTarget(),
    };
    expect(deriveSelectedChecksPermission(s, confirmation)).toEqual({
      permission: "unknown",
      scopes: [],
      status: "confirmed",
    });
  });

  it("treats unauthenticated sessions as read-only", () => {
    const s = stamp();
    const confirmation: SelectedChecksConfirmation = {
      stamp: s,
      status: "confirmed",
      session: { authenticated: false, auth: AUTH_DESCRIPTOR },
      attempt: 1,
      target: confirmationTarget(),
    };
    expect(deriveSelectedChecksPermission(s, confirmation).permission).toBe("read-only");
  });
});

describe("createSelectedChecksSessionConfirmation", () => {
  const command = () => createSelectedChecksSessionConfirmation(bag.testRuntime);

  const confirmInput = (
    overrides: {
      generation?: number;
      prepared?: PreparedConnection;
      entry?: ConnectionCatalogEntry;
    } = {},
  ) => ({
    environmentId,
    input: {
      generation: overrides.generation ?? 1,
      prepared: overrides.prepared ?? bag.prepared,
      entry: overrides.entry ?? bag.catalogEntry,
    },
  });

  it("uses the same catalog object the service registry exposes", async () => {
    expect(await bag.readServiceEntry()).toBe(bag.catalogEntry);
  });

  it("confirms when the lease and catalog entry are stable across fetch", async () => {
    const session = OPERATE_SESSION;
    root.authFetch.mockReturnValueOnce(Effect.succeed(session));
    const result = await runAtomCommand(bag.registry, command(), confirmInput(), {
      reportFailure: false,
    });
    expect(result).toMatchObject({ _tag: "Success", value: { kind: "confirmed", session } });
    expect(root.authFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a mismatched catalog entry before fetch", async () => {
    root.authFetch.mockClear();
    const staleEntry: ConnectionCatalogEntry = {
      target: bag.catalogEntry.target,
      profile: bag.catalogEntry.profile,
      enabled: bag.catalogEntry.enabled,
    };
    const result = await runAtomCommand(
      bag.registry,
      command(),
      confirmInput({ entry: staleEntry }),
      { reportFailure: false },
    );
    expect(result).toMatchObject({ _tag: "Success", value: { kind: "stale" } });
    expect(root.authFetch).not.toHaveBeenCalled();
  });

  it("rejects pre-fetch lease mismatch without calling fetch", async () => {
    root.authFetch.mockClear();
    const result = await runAtomCommand(bag.registry, command(), confirmInput({ generation: 99 }), {
      reportFailure: false,
    });
    expect(result).toMatchObject({ _tag: "Success", value: { kind: "stale" } });
    expect(root.authFetch).not.toHaveBeenCalled();
  });

  it("settles stale when the service registry entry is replaced during fetch", async () => {
    const replacement: ConnectionCatalogEntry = {
      target: bag.catalogEntry.target,
      profile: bag.catalogEntry.profile,
      enabled: !bag.catalogEntry.enabled,
    };
    root.authFetch.mockImplementationOnce(() =>
      Effect.gen(function* () {
        yield* bag.replaceServiceEntryEffect(replacement);
        return OPERATE_SESSION;
      }),
    );
    const result = await runAtomCommand(bag.registry, command(), confirmInput(), {
      reportFailure: false,
    });
    expect(result).toMatchObject({ _tag: "Success", value: { kind: "stale" } });
    expect(root.authFetch).toHaveBeenCalledTimes(1);
  });

  it("stays stale when the UI catalog still shows the old entry but service already moved on", async () => {
    root.authFetch.mockClear();
    const serviceReplacement: ConnectionCatalogEntry = {
      target: bag.catalogEntry.target,
      profile: bag.catalogEntry.profile,
      enabled: !bag.catalogEntry.enabled,
    };
    await bag.runFixtureCommand(bag.fixture.replaceServiceEntry, {
      entry: serviceReplacement,
    });
    const result = await runAtomCommand(
      bag.registry,
      command(),
      confirmInput({ entry: bag.catalogEntry }),
      { reportFailure: false },
    );
    expect(result).toMatchObject({ _tag: "Success", value: { kind: "stale" } });
    expect(root.authFetch).not.toHaveBeenCalled();
  });

  it("settles stale when fetch succeeds but the rpc session identity changes", async () => {
    const altClient: SelectedChecksRpcClient = {
      [WS_METHODS.selectedChecksGet]: () => Effect.succeed(emptyGetResult()),
      [WS_METHODS.selectedChecksRun]: () => Effect.succeed({ attemptId: "x" }),
      [WS_METHODS.selectedChecksCancel]: () => Effect.succeed({ cancelled: true }),
      [WS_METHODS.selectedChecksResolveOwnership]: () =>
        Effect.succeed({ outcome: "acknowledged", admission: { state: "open" } }),
    };
    root.authFetch.mockImplementationOnce(() =>
      Effect.gen(function* () {
        yield* bag.swapRpcSession(altClient);
        return OPERATE_SESSION;
      }),
    );
    const result = await runAtomCommand(bag.registry, command(), confirmInput(), {
      reportFailure: false,
    });
    expect(result).toMatchObject({ _tag: "Success", value: { kind: "stale" } });
  });
});

describe("useSelectedChecks", () => {
  beforeEach(async () => {
    await mountConfirmed();
  });

  it("does not leave permission checking forever after StrictMode effect replay", async () => {
    expect(latest.permissionStatus).toBe("confirmed");
    expect(latest.permission).toBe("allowed");
  });

  it("does not call selectedChecks.get while the panel stays closed", async () => {
    expect(root.getCalls).toHaveLength(0);
  });

  it("starts exactly one get when the panel opens", async () => {
    await act(() => latest.openPanel());
    expect(bag.getLedger.entered).toBe(1);
    expect(bag.getLedger.settled).toBe(0);
    expect(root.getCalls).toHaveLength(1);
    await settleGet();
    expect(bag.getLedger.settled).toBe(1);
    expect(bag.getLedger.pending).toHaveLength(0);
    expect(latest.view.open).toBe(true);
  });

  it("starts a new bounded auth check on manual refresh after confirmation", async () => {
    await act(() => latest.openPanel());
    await settleGet();
    const before = root.authFetch.mock.calls.length;
    queueAuth();
    await act(() => latest.refresh());
    expect(root.authFetch.mock.calls.length - before).toBe(1);
    await resolveAuth();
    expect(latest.permissionStatus).toBe("confirmed");
  });

  it("issues one additional get when only a registry project script command changes", async () => {
    const project = makeProject();
    seedRegistry(project);
    await act(() => latest.openPanel());
    await settleGet();
    expect(root.getCalls).toHaveLength(1);
    seedRegistry(
      makeProject("/workspace", [projectScript("lint", "pnpm lint --fix"), project.scripts[1]!]),
    );
    await act(async () => {
      await Promise.resolve();
    });
    await settleGet();
    expect(root.getCalls).toHaveLength(2);
  });

  it("blocks run when registry project workspace changes before React rerenders", async () => {
    await act(() => latest.openPanel());
    await settleGet();
    await act(() => latest.toggle("lint"));
    await act(() => latest.run());
    expect(root.runCalls).toHaveLength(1);
    await settleGet();
    expect(latest.view.canRun).toBe(true);
    await act(() => {
      bag.registry.set(bag.projectAtom, makeProject("/other-workspace"));
      bag.flushRegistry();
    });
    await act(() => latest.run());
    expect(root.runCalls).toHaveLength(1);
  });

  it("drops a stale get completion after the connection generation changes", async () => {
    await act(() => latest.openPanel());
    expect(bag.getLedger.entered).toBe(1);
    const firstOrdinal = 1;
    queueAuth();
    await act(async () => {
      await bag.setConnectionGeneration(2);
    });
    await resolveAuth();
    await releaseGetOrdinal(firstOrdinal, getWithAdmission(STALE_ADMISSION_SHA), {
      waitForIdle: false,
    });
    expectAdmissionDigestNot(STALE_ADMISSION_SHA);
    expect(latest.view.getInFlight).toBe(true);
    await waitForGetEntered(2);
    await releaseGetOrdinal(2, getWithAdmission(FRESH_ADMISSION_SHA), { waitForIdle: true });
    expectAdmissionDigest(FRESH_ADMISSION_SHA);
    expect(latest.view.getInFlight).toBe(false);
  });

  it("settles the newest get after refresh even when the prior response was still pending", async () => {
    await act(() => latest.openPanel());
    expect(bag.getLedger.entered).toBe(1);
    const firstOrdinal = 1;
    queueAuth();
    await act(() => latest.refresh());
    expect(bag.getLedger.entered).toBe(1);
    await resolveAuth();
    expect(bag.getLedger.entered).toBe(1);
    await releaseGetOrdinal(firstOrdinal, getWithAdmission(STALE_ADMISSION_SHA), {
      waitForIdle: false,
    });
    expectAdmissionDigestNot(STALE_ADMISSION_SHA);
    await waitForGetEntered(2);
    await releaseGetOrdinal(2, getWithAdmission(FRESH_ADMISSION_SHA), { waitForIdle: true });
    expect(bag.getLedger.entered).toBe(2);
    expectAdmissionDigest(FRESH_ADMISSION_SHA);
    expect(latest.view.getInFlight).toBe(false);
    expect(latest.view.getError).toBeNull();
  });

  it("does not follow up with get after unmount", async () => {
    await act(() => latest.openPanel());
    const enteredBeforeUnmount = bag.getLedger.entered;
    const pendingOrdinal = bag.getLedger.pending[0]!.ordinal;
    await act(() => renderer?.unmount());
    renderer = undefined;
    await act(async () => {
      bag.resolveGetOrdinal(pendingOrdinal, emptyGetResult());
      bag.flushRegistry();
    });
    expect(bag.getLedger.entered).toBe(enteredBeforeUnmount);
  });

  it("does not follow up with get after unmount when a held run completion would refetch", async () => {
    await act(() => latest.openPanel());
    await settleGet();
    const baselineGets = bag.getLedger.entered;
    await act(() => latest.toggle("lint"));
    const heldRun = bag.armRunGate();
    const runObservation = observeSelectedChecksRunCommand();
    try {
      await act(() => latest.run());
      expect(root.runCalls).toHaveLength(1);
      expect(bag.getLedger.entered).toBe(baselineGets);
      const commandPromise = runObservation.commandPromise();
      expect(commandPromise).toBeDefined();
      await act(() => renderer?.unmount());
      renderer = undefined;
      await act(async () => {
        heldRun.resolve({ attemptId: "attempt-1" });
        await commandPromise;
        bag.flushRegistry();
      });
      expect(bag.getLedger.entered).toBe(baselineGets);
    } finally {
      runObservation.restore();
    }
  });

  it("schedules exactly one post-run get after a held run completes while mounted", async () => {
    await act(() => latest.openPanel());
    await settleGet();
    const baselineGets = bag.getLedger.entered;
    await act(() => latest.toggle("lint"));
    const heldRun = bag.armRunGate();
    const runObservation = observeSelectedChecksRunCommand();
    try {
      await act(() => latest.run());
      expect(root.runCalls).toHaveLength(1);
      expect(bag.getLedger.entered).toBe(baselineGets);
      const commandPromise = runObservation.commandPromise();
      expect(commandPromise).toBeDefined();
      await act(async () => {
        heldRun.resolve({ attemptId: "attempt-1" });
        await commandPromise;
        bag.flushRegistry();
      });
      await waitForGetEntered(baselineGets + 1);
      expect(bag.getLedger.entered).toBe(baselineGets + 1);
      await settleGet();
    } finally {
      runObservation.restore();
    }
  });

  it("invalidates stale confirmation when retryPermission runs after a failed check", async () => {
    queueAuth();
    root.authFetch.mockImplementationOnce(() =>
      Effect.tryPromise({
        try: () => Promise.reject(new Error("offline")),
        catch: (cause) => new AuthFetchError({ cause }),
      }),
    );
    await act(() => latest.retryPermission());
    await flushUntil(() => latest.permissionStatus === "failed");
    queueAuth();
    await act(() => latest.retryPermission());
    await resolveAuth();
    expect(latest.permissionStatus).toBe("confirmed");
  });

  it("does not submit recovery when the acknowledgement checkbox is false", async () => {
    const sha = digestHex("f");
    await act(() => latest.openPanel());
    await settleGet(getWithAdmission(sha));
    await act(() => latest.openRecoveryDialog());
    await act(() => latest.toggle("lint"));
    await act(() => latest.submitRecoveryDialog(false));
    expect(root.resolveCalls).toHaveLength(0);
    expect(latest.view.dialogSubmit?.allowed).toBe(true);
    await act(() => latest.submitRecoveryDialog(true));
    expect(root.resolveCalls).toEqual([{ markerSha256: sha, acknowledgeUncertainty: true }]);
  });

  it("starts a fresh get when the target thread changes but candidates stay identical", async () => {
    await act(() => latest.openPanel());
    await settleGet();
    expect(root.getCalls.map((call) => call.ordinal)).toEqual([1]);
    await act(() => latest.toggle("lint"));
    expect(latest.view.selection).toEqual(["lint"]);
    const otherThread = ThreadId.make("thread-other");
    const project = makeProject();
    queueAuth();
    await act(() => {
      bag.registry.set(bag.shellAtom, makeShell({ id: otherThread, title: "Other thread" }));
      bag.registry.set(bag.statusAtom, "live");
      bag.flushRegistry();
      renderer?.update(
        createElement(
          RegistryContext.Provider,
          { value: bag.registry },
          createElement(
            StrictMode,
            null,
            createElement(Probe, {
              project,
              candidates: project.scripts,
              threadId: otherThread,
            }),
          ),
        ),
      );
    });
    await waitForGetEntered(2);
    expect(root.getCalls[1]).toEqual({ threadId: otherThread, ordinal: 2 });
    await releaseGetOrdinal(2, getWithAdmission(FRESH_ADMISSION_SHA, otherThread), {
      waitForIdle: false,
    });
    await resolveAuth();
    await waitForGetEntered(3);
    expect(root.getCalls[2]).toEqual({ threadId: otherThread, ordinal: 3 });
    await releaseGetOrdinal(3, getWithAdmission(FRESH_ADMISSION_SHA, otherThread), {
      waitForIdle: true,
    });
    expect(root.getCalls.map((call) => call.threadId)).toEqual([
      threadId,
      otherThread,
      otherThread,
    ]);
    expect(latest.view.selection).toEqual([]);
    expect(latest.candidates.map((script) => script.id)).toContain("lint");
    await act(() => latest.toggle("lint"));
    expect(latest.view.selection).toEqual(["lint"]);
  });

  it("bumps lifecycle when the shell is removed and restored with the same scalar fields", async () => {
    expect(
      selectedChecksLifecycleKey({
        environmentId,
        threadId,
        incarnation: 0,
        connected: true,
        connectionGeneration: 1,
        auth: {
          permission: "allowed",
          entryId: 1,
          generation: 1,
          preparedId: 2,
          scopes: [AuthOrchestrationOperateScope],
        },
        project: { id: projectId, workspaceRoot: "/workspace" },
        thread: {
          createdAt: "2026-10-01T00:00:00.000Z",
          projectId,
          worktreePath: "/worktree",
        },
      }),
    ).toBeTruthy();
    await act(() => latest.openPanel());
    await settleGet();
    const enteredBaseline = bag.getLedger.entered;
    bag.registry.set(bag.shellAtom, null);
    bag.registry.set(bag.statusAtom, "deleted");
    bag.flushRegistry();
    bag.registry.set(bag.shellAtom, makeShell());
    bag.registry.set(bag.statusAtom, "live");
    bag.flushRegistry();
    await act(async () => {
      await Promise.resolve();
    });
    await act(() => latest.openPanel());
    await flushUntil(() => bag.getLedger.entered === enteredBaseline + 1);
    expect(root.getCalls.at(-1)?.ordinal).toBe(enteredBaseline + 1);
    await settleGet();
  });

  it("coalesces duplicate focus notifications while a confirmation is already checking", async () => {
    await act(() => latest.openPanel());
    await settleGet();
    const before = root.authFetch.mock.calls.length;
    queueAuth();
    await act(() => latest.refresh());
    await act(() => {
      domListeners.focus();
      domListeners.visibility();
    });
    expect(root.authFetch.mock.calls.length - before).toBe(1);
    await resolveAuth();
  });

  it("ignores a stale get completion after the connection generation changes while the panel stays open", async () => {
    await act(() => latest.openPanel());
    expect(bag.getLedger.entered).toBe(1);
    const firstOrdinal = 1;
    queueAuth();
    await act(async () => {
      await bag.setConnectionGeneration(2);
    });
    await resolveAuth();
    await releaseGetOrdinal(firstOrdinal, getWithAdmission(STALE_ADMISSION_SHA), {
      waitForIdle: false,
    });
    expectAdmissionDigestNot(STALE_ADMISSION_SHA);
    expect(latest.view.getInFlight).toBe(true);
    await waitForGetEntered(2);
    await releaseGetOrdinal(2, getWithAdmission(FRESH_ADMISSION_SHA), { waitForIdle: true });
    expectAdmissionDigest(FRESH_ADMISSION_SHA);
    expect(latest.view.getInFlight).toBe(false);
  });

  it("surfaces a visible get error when the in-flight get Effect is interrupted", async () => {
    bag.interruptNextGet.current = true;
    await act(() => latest.openPanel());
    expect(bag.getLedger.entered).toBe(1);
    expect(bag.getLedger.settled).toBe(1);
    await flushUntil(() => latest.view.getError !== null && !latest.view.getInFlight);
    expect(latest.view.getError).toBe("The request was interrupted.");
    expect(latest.view.getInFlight).toBe(false);
    expect(bag.getLedger.pending).toHaveLength(0);
  });

  it("does not let pending auth on A authorize or strand B after switching targets", async () => {
    const threadB = ThreadId.make("thread-b-auth");
    expect(latest.permissionStatus).toBe("confirmed");
    expect(root.getCalls).toHaveLength(0);
    const authCallsBeforeA = root.authFetch.mock.calls.length;
    const authA = queueAuth();
    await act(() => latest.refresh());
    expect(root.authFetch.mock.calls.length - authCallsBeforeA).toBe(1);
    expect(latest.permissionStatus).toBe("checking");

    const authCallsBeforeB = root.authFetch.mock.calls.length;
    const authB = queueAuth();
    await act(() => {
      bag.registry.set(bag.shellAtom, makeShell({ id: threadB, title: "Thread B" }));
      bag.registry.set(bag.statusAtom, "live");
      bag.flushRegistry();
      renderer?.update(
        createElement(
          RegistryContext.Provider,
          { value: bag.registry },
          createElement(
            StrictMode,
            null,
            createElement(Probe, {
              project: makeProject(),
              candidates: makeProject().scripts,
              threadId: threadB,
            }),
          ),
        ),
      );
    });
    await flushUntil(() => root.authFetch.mock.calls.length - authCallsBeforeB >= 1);
    expect(latest.permissionStatus).toBe("checking");
    expect(latest.permission).toBe("unknown");

    await act(async () => {
      authA.resolve(OPERATE_SESSION);
      bag.flushRegistry();
    });
    expect(latest.permissionStatus).toBe("checking");
    expect(latest.permission).toBe("unknown");
    expect(root.getCalls).toHaveLength(0);
    expect(root.runCalls).toHaveLength(0);

    await act(async () => {
      authB.resolve(OPERATE_SESSION);
      bag.flushRegistry();
    });
    await flushUntil(() => latest.permissionStatus === "confirmed");
    expect(latest.permission).toBe("allowed");
    expect(root.getCalls).toHaveLength(0);

    await act(() => latest.openPanel());
    expect(root.getCalls).toEqual([{ threadId: threadB, ordinal: 1 }]);
    await settleGet(getWithAdmission(FRESH_ADMISSION_SHA, threadB));
    expectAdmissionDigest(FRESH_ADMISSION_SHA);
  });

  it("does not reconcile back to thread A when a stale get for A completes after switching to B", async () => {
    const threadA = threadId;
    const threadB = ThreadId.make("thread-b");
    await act(() => latest.openPanel());
    expect(root.getCalls).toEqual([{ threadId: threadA, ordinal: 1 }]);
    queueAuth();
    await act(() => {
      bag.registry.set(bag.shellAtom, makeShell({ id: threadB, title: "Thread B" }));
      bag.registry.set(bag.statusAtom, "live");
      bag.flushRegistry();
      renderer?.update(
        createElement(
          RegistryContext.Provider,
          { value: bag.registry },
          createElement(
            StrictMode,
            null,
            createElement(Probe, {
              project: makeProject(),
              candidates: makeProject().scripts,
              threadId: threadB,
            }),
          ),
        ),
      );
    });
    await waitForGetEntered(2);
    const bCallsBeforeStale = root.getCalls.filter((call) => call.threadId === threadB).length;
    expect(bCallsBeforeStale).toBeGreaterThanOrEqual(1);
    await releaseGetOrdinal(1, getWithAdmission(STALE_ADMISSION_SHA, threadA), {
      waitForIdle: false,
    });
    expectAdmissionDigestNot(STALE_ADMISSION_SHA);
    expect(root.getCalls.filter((call) => call.threadId === threadA)).toHaveLength(1);
    expect(root.getCalls.filter((call) => call.threadId === threadB).length).toBe(
      bCallsBeforeStale,
    );
    await resolveAuth();
    await releaseGetOrdinal(2, getWithAdmission(FRESH_ADMISSION_SHA, threadB), {
      waitForIdle: false,
    });
    await waitForGetEntered(3);
    await releaseGetOrdinal(3, getWithAdmission(FRESH_ADMISSION_SHA, threadB), {
      waitForIdle: true,
    });
    expectAdmissionDigest(FRESH_ADMISSION_SHA);
    expect(root.getCalls.filter((call) => call.threadId === threadA)).toHaveLength(1);
  });

  it("withholds recovery submit when admission digest changes after the dialog opened", async () => {
    const admissionD = digestHex("d");
    const admissionE = digestHex("e");
    const project = makeProject();
    seedRegistry(project);
    await act(() => latest.openPanel());
    await settleGet(getWithAdmission(admissionD));
    await act(() => latest.openRecoveryDialog());
    expect(latest.view.dialogSubmit?.allowed).toBe(true);
    await act(() => {
      seedRegistry(
        makeProject("/workspace", [
          projectScript("lint", "pnpm lint --digest-rotation"),
          project.scripts[1]!,
        ]),
      );
    });
    expect(latest.view.dialogSubmit?.allowed ?? false).toBe(false);
    await waitForGetEntered(2);
    await releaseGetOrdinal(2, getWithAdmission(admissionE), { waitForIdle: false });
    expect(latest.view.dialogSubmit?.allowed ?? false).toBe(false);
    await act(() => latest.submitRecoveryDialog(true));
    expect(root.resolveCalls).toHaveLength(0);
    await act(() => latest.openRecoveryDialog());
    expect(latest.view.dialogSubmit?.allowed).toBe(true);
    await act(() => latest.toggle("lint"));
    await act(() => latest.submitRecoveryDialog(true));
    expect(root.resolveCalls).toEqual([{ markerSha256: admissionE, acknowledgeUncertainty: true }]);
    await waitForGetEntered(3);
    await releaseGetOrdinal(3, emptyGetResult(), { waitForIdle: true });
  });

  it("cancels the displayed running attempt with the exact attempt id", async () => {
    await act(() => latest.openPanel());
    await settleGet(presentRunningGet("cancel-attempt-1"));
    expect(latest.view.canStop).toBe(true);
    expect(latest.view.stopAttemptId).toBe("cancel-attempt-1");
    await act(() => latest.stop());
    expect(root.cancelCalls).toEqual([{ threadId, attemptId: "cancel-attempt-1" }]);
    await act(async () => {
      await bag.setConnectionGeneration(2);
    });
    expect(latest.view.canStop).toBe(false);
    await act(() => latest.stop());
    expect(root.cancelCalls).toHaveLength(1);
  });

  it("withholds recovery submit when lifecycle moves on while the dialog is open", async () => {
    const markerSha = "c".repeat(64);
    await act(() => latest.openPanel());
    await settleGet({
      ...emptyGetResult(),
      admission: {
        state: "owner-unresolved",
        marker: {
          sha256: markerSha,
          threadId,
          attemptId: "attempt-x",
          scriptId: null,
          pgid: null,
          writtenAt: "2026-10-01T00:00:00.000Z",
        },
      },
    });
    await act(() => latest.openRecoveryDialog());
    expect(latest.view.dialogSubmit?.allowed).toBe(true);
    await act(async () => {
      await bag.setConnectionGeneration(2);
    });
    expect(latest.view.dialogSubmit?.allowed ?? false).toBe(false);
    await act(() => latest.submitRecoveryDialog(true));
    expect(root.resolveCalls).toHaveLength(0);
  });

  it("uses settings overrides for candidates when registry project scripts are empty", async () => {
    const overrideAction = projectScript("settings-lint", "pnpm settings-lint");
    const emptyProject = makeProject("/workspace", []);
    await act(() => {
      bag.registry.set(bag.settingsAtom, settingsWithProjectScripts(projectId, [overrideAction]));
      seedRegistry(emptyProject);
    });
    await remountWithProjectAndCandidates(emptyProject, []);
    expect(latest.candidates.map((script) => script.id)).toEqual(["settings-lint"]);
    await act(() => latest.openPanel());
    await settleGet();
    await act(() => latest.toggle("settings-lint"));
    await act(() => latest.run());
    expect(root.runCalls).toEqual([{ threadId, scriptIds: ["settings-lint"] }]);
  });

  it("blocks run when a settings override changes synchronously before invoke, then allows after reconcile", async () => {
    const overrideAction = projectScript("settings-lint", "pnpm settings-lint");
    const emptyProject = makeProject("/workspace", []);
    await act(() => {
      bag.registry.set(bag.settingsAtom, settingsWithProjectScripts(projectId, [overrideAction]));
      seedRegistry(emptyProject);
    });
    await remountWithProjectAndCandidates(emptyProject, []);
    await act(() => latest.openPanel());
    await settleGet();
    await act(() => latest.toggle("settings-lint"));
    await act(() => {
      bag.registry.set(
        bag.settingsAtom,
        settingsWithProjectScripts(projectId, [
          projectScript("settings-lint", "pnpm settings-lint --changed"),
        ]),
      );
      latest.run();
    });
    expect(root.runCalls).toHaveLength(0);
    await waitForGetEntered(2);
    await releaseGetOrdinal(2, emptyGetResult(), { waitForIdle: true });
    expect(latest.view.selection).toEqual(["settings-lint"]);
    expect(latest.view.canRun).toBe(true);
    await act(() => latest.run());
    expect(root.runCalls).toEqual([{ threadId, scriptIds: ["settings-lint"] }]);
    await settleGet();
  });

  it("blocks run when a settings override removes the selected action before invoke", async () => {
    const overrideAction = projectScript("settings-lint", "pnpm settings-lint");
    const emptyProject = makeProject("/workspace", []);
    await act(() => {
      bag.registry.set(bag.settingsAtom, settingsWithProjectScripts(projectId, [overrideAction]));
      seedRegistry(emptyProject);
    });
    await remountWithProjectAndCandidates(emptyProject, []);
    await act(() => latest.openPanel());
    await settleGet();
    await act(() => latest.toggle("settings-lint"));
    await act(() => {
      bag.registry.set(bag.settingsAtom, settingsWithProjectScripts(projectId, []));
      latest.run();
    });
    expect(root.runCalls).toHaveLength(0);
    expect(latest.view.selection).toEqual([]);
    expect(latest.candidates).toEqual([]);
    await waitForGetEntered(2);
    await releaseGetOrdinal(2, emptyGetResult(), { waitForIdle: true });
    await act(() => {
      bag.registry.set(bag.settingsAtom, settingsWithProjectScripts(projectId, [overrideAction]));
      bag.flushRegistry();
    });
    await waitForGetEntered(3);
    await releaseGetOrdinal(3, emptyGetResult(), { waitForIdle: true });
    expect(latest.candidates.map((script) => script.id)).toEqual(["settings-lint"]);
    expect(latest.view.selection).toEqual([]);
    await act(() => latest.toggle("settings-lint"));
    expect(latest.view.canRun).toBe(true);
    await act(() => latest.run());
    expect(root.runCalls).toEqual([{ threadId, scriptIds: ["settings-lint"] }]);
    await settleGet();
  });

  it("blocks recovery submit when permission is stale during an open dialog", async () => {
    await act(() => latest.openPanel());
    await settleGet({
      ...emptyGetResult(),
      admission: {
        state: "owner-unresolved",
        marker: {
          sha256: "a".repeat(64),
          threadId,
          attemptId: "attempt-x",
          scriptId: null,
          pgid: null,
          writtenAt: "2026-10-01T00:00:00.000Z",
        },
      },
    });
    await act(() => latest.openRecoveryDialog());
    queueAuth();
    await act(() => latest.refresh());
    expect(latest.view.dialogSubmit?.allowed ?? false).toBe(false);
    await act(() => latest.submitRecoveryDialog(true));
    expect(root.resolveCalls).toHaveLength(0);
  });

  describe("readCurrentSource", () => {
    async function openAndSettlePassed() {
      await act(() => latest.openPanel());
      await settleGet(presentPassedGet());
      expect(latest.view.headline).toBe("passed");
    }

    async function readSource(): Promise<SelectedChecksCurrentSource | null> {
      let source: SelectedChecksCurrentSource | null = null;
      await act(() => {
        source = latest.readCurrentSource();
      });
      return source;
    }

    it("returns the current passed source while the controller stays open", async () => {
      await openAndSettlePassed();
      const first = await readSource();
      expect(first).not.toBeNull();
      expect(first?.projectId).toBe(projectId);
      expect(first?.environmentId).toBe(environmentId);
      expect(first?.threadId).toBe(threadId);
      expect(first?.lifecycleKey).toEqual(expect.any(String));
      expect(first?.permissionStatus).toBe("confirmed");
      expect(first?.confirmationAttempt).toBeGreaterThan(0);
      expect(first?.recordKey).toBe("run-attempt-1:2:7:completed");
      expect(first?.permission).toBe("allowed");
      expect(first?.view.open).toBe(true);
      expect(first?.view.headline).toBe("passed");
      expect(first?.view.recordAuthority).toBe("current");
      expect(first?.view.record?.sequence).toBe(7);
      expect(first?.view.record?.receipt.attemptId).toBe("run-attempt-1");
      expect(first?.view.record?.receipt.revision).toBe(2);
      expect(first?.view.comparisonStale).toBe(false);
      expect(first?.view.newerTurnAfterRecord).toBe(false);
      expect(first?.view.changedScriptIds).toEqual([]);
      expect(first?.view.commandInFlight).toBeNull();
      const second = await readSource();
      expect(second?.projectId).toBe(projectId);
      expect(second?.view.record?.sequence).toBe(7);
      expect(second?.view.record?.receipt.revision).toBe(2);
      expect(latest.view.open).toBe(true);
      expect(bag.getLedger.entered).toBe(1);
    });

    it("returns the unread view with no record authority while the controller is closed", async () => {
      const source = await readSource();
      expect(source).not.toBeNull();
      expect(source?.projectId).toBe(projectId);
      expect(source?.permission).toBe("allowed");
      expect(source?.view.open).toBe(false);
      expect(source?.view.recordAuthority).toBeNull();
      expect(source?.view.record).toBeNull();
      expect(bag.getLedger.entered).toBe(0);
    });

    it("reports the fresh permission after reconfirmation narrows the session", async () => {
      await openAndSettlePassed();
      queueAuth();
      await act(() => latest.refresh());
      const mid = await readSource();
      expect(mid).not.toBeNull();
      expect(mid?.projectId).toBe(projectId);
      expect(mid?.permission).toBe("unknown");
      expect(mid?.view.recordAuthority).toBe("previous");
      expect(mid?.view.getInFlight).toBe(true);
      await resolveAuth(READ_ONLY_SESSION);
      // The get command runs under "latest" concurrency per thread: the
      // revalidation get stays queued behind the in-flight one and enters
      // only after it settles (that stale result is dropped by generation).
      await releaseGetOrdinal(2, presentPassedGet(), { waitForIdle: false });
      await waitForGetEntered(3);
      await settleGet(presentPassedGet(), 3);
      const after = await readSource();
      expect(after?.permission).toBe("read-only");
      expect(after?.projectId).toBe(projectId);
      expect(after?.view.headline).toBe("passed");
      expect(after?.view.recordAuthority).toBe("current");
    });

    it("rejects when the fresh thread shell no longer matches the target thread", async () => {
      await openAndSettlePassed();
      const otherThread = ThreadId.make("thread-source-other");
      await act(() => {
        bag.registry.set(bag.shellAtom, makeShell({ id: otherThread }));
        bag.flushRegistry();
      });
      expect(await readSource()).toBeNull();
    });

    it("rejects when the target thread is missing", async () => {
      await openAndSettlePassed();
      await act(() => {
        bag.registry.set(bag.shellAtom, null);
        bag.flushRegistry();
      });
      expect(await readSource()).toBeNull();
    });

    it("rejects while the target thread reads as deleted", async () => {
      await openAndSettlePassed();
      await act(() => {
        bag.registry.set(bag.statusAtom, "deleted");
        bag.flushRegistry();
      });
      expect(await readSource()).toBeNull();
    });

    it("rejects when the scoped project record is missing", async () => {
      await openAndSettlePassed();
      await act(() => {
        bag.registry.set(bag.projectAtom, null);
        bag.flushRegistry();
      });
      expect(await readSource()).toBeNull();
    });

    it("rejects when the scoped project does not match the thread's project", async () => {
      await openAndSettlePassed();
      await act(() => {
        bag.registry.set(bag.projectAtom, {
          ...makeProject(),
          id: ProjectId.make("project-other"),
        });
        bag.flushRegistry();
      });
      expect(await readSource()).toBeNull();
    });

    it("reports a newer live revision instead of the settled current record", async () => {
      await openAndSettlePassed();
      const newer = makePassingReceipt({ revision: 3 });
      await act(() => {
        bag.registry.set(bag.detailAtom, {
          ...makeThreadDetail(),
          activities: [liveReceiptActivity(newer, 9)],
        });
        bag.flushRegistry();
      });
      const source = await readSource();
      expect(source).not.toBeNull();
      expect(source?.projectId).toBe(projectId);
      expect(source?.permission).toBe("allowed");
      expect(source?.view.liveIsNewer).toBe(true);
      expect(source?.view.recordAuthority).toBe("live");
      expect(source?.view.headline).toBe("awaiting-confirmation");
      expect(source?.view.record?.receipt.revision).toBe(3);
      expect(source?.view.record?.sequence).toBe(9);
      await waitForGetEntered(2);
      await settleGet(presentPassedGet(), 2);
    });
  });

  describe("recordIdentity", () => {
    async function openAndSettlePassed() {
      await act(() => latest.openPanel());
      await settleGet(presentPassedGet());
      expect(latest.view.headline).toBe("passed");
    }

    it("stays null while the panel is closed", () => {
      expect(latest.recordIdentity).toBeNull();
    });

    it("stays null while no passed record is current", async () => {
      await act(() => latest.openPanel());
      await settleGet(emptyGetResult());
      expect(latest.view.headline).toBe("none");
      expect(latest.recordIdentity).toBeNull();
    });

    it("binds the current passed record with stamp, incarnation, and permission", async () => {
      await openAndSettlePassed();
      expect(latest.recordIdentity).toMatchObject({
        environmentId,
        threadId,
        attemptId: "run-attempt-1",
        revision: 2,
        receiptSequence: 7,
        stamp: { generation: 1 },
        incarnation: 0,
        permission: "allowed",
        permissionStatus: "confirmed",
      });
    });

    it("unbinds while permission confirmation is in flight", async () => {
      await openAndSettlePassed();
      queueAuth();
      await act(() => latest.refresh());
      expect(latest.recordIdentity).toBeNull();
      await resolveAuth(READ_ONLY_SESSION);
      await waitForGetEntered(2);
      await releaseGetOrdinal(2, presentPassedGet(), { waitForIdle: false });
      await waitForGetEntered(3);
      await settleGet(presentPassedGet(), 3);
      expect(latest.recordIdentity).toMatchObject({
        attemptId: "run-attempt-1",
        revision: 2,
        receiptSequence: 7,
        permission: "read-only",
        permissionStatus: "confirmed",
      });
    });

    it("unbinds for a newer live record that has not been confirmed", async () => {
      await openAndSettlePassed();
      const newer = makePassingReceipt({ revision: 3 });
      await act(() => {
        bag.registry.set(bag.detailAtom, {
          ...makeThreadDetail(),
          activities: [liveReceiptActivity(newer, 9)],
        });
        bag.flushRegistry();
      });
      expect(latest.view.recordAuthority).toBe("live");
      expect(latest.recordIdentity).toBeNull();
      await waitForGetEntered(2);
      await settleGet(presentPassedGet(), 2);
    });

    it("readRecordIdentity returns the bound identity fresh at act time", async () => {
      let fresh: SelectedChecksRecordIdentity | null = null;
      await act(() => {
        fresh = latest.readRecordIdentity();
      });
      expect(fresh).toBeNull();

      await openAndSettlePassed();
      await act(() => {
        fresh = latest.readRecordIdentity();
      });
      expect(fresh).toMatchObject({
        environmentId,
        threadId,
        attemptId: "run-attempt-1",
        revision: 2,
        receiptSequence: 7,
        stamp: { generation: 1 },
        permissionStatus: "confirmed",
      });
      expect(fresh).toEqual(latest.recordIdentity);
    });
  });
});
