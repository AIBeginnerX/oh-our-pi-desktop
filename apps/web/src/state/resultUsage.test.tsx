import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  OWNED_RESULT_USAGE_READ_ERROR_DETAIL,
  OwnedResultUsageReadError,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type AuthSessionState,
  type EnvironmentId as EnvironmentIdType,
  type OwnedResultCoverageV1,
  type OwnedResultUsageOutcome,
  type ProjectId as ProjectIdType,
  type ProjectScript,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type SelectedCheckReceipt,
  type SelectedChecksGetResult,
  type ServerSettings,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentRpcInput, RpcSession } from "@t3tools/client-runtime/rpc";
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
import type {
  AtomCommand,
  AtomCommandOptions,
  AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import { act, createElement, StrictMode, useLayoutEffect, useRef } from "react";
import { create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { Writable } from "effect/unstable/reactivity/Atom";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";

const recorded = vi.hoisted(() => ({
  completions: [] as Array<{ label: string; promise: Promise<unknown> }>,
}));

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

// Wraps the real useAtomCommand: every call records the exact promise the
// hook awaits, by command label and call order. No command is substituted.
vi.mock("./use-atom-command", async (importOriginal) => {
  const original = await importOriginal<typeof import("./use-atom-command")>();
  return {
    ...original,
    useAtomCommand: <A, E, W>(
      command: AtomCommand<W, A, E>,
      options?: string | AtomCommandOptions,
    ): ((value: W) => Promise<AtomCommandResult<A, E>>) => {
      const run = original.useAtomCommand<A, E, W>(command, options);
      // Preserve the original hook's stable callback identity across renders.
      const stable = useRef<((value: W) => Promise<AtomCommandResult<A, E>>) | undefined>(
        undefined,
      );
      if (stable.current === undefined) {
        stable.current = (value: W) => {
          const promise = run(value);
          recorded.completions.push({ label: command.label, promise });
          return promise;
        };
      }
      return stable.current;
    },
  };
});

// The disclosure test drives the real panel through the real hook; the dialog
// primitives themselves are not under test.
vi.mock("../components/ui/dialog", () => ({
  Dialog: "div",
  DialogDescription: "p",
  DialogFooter: "footer",
  DialogHeader: "header",
  DialogPanel: "div",
  DialogPopup: "div",
  DialogTitle: "h2",
}));
vi.mock("../components/ui/badge", () => ({ Badge: "span" }));
vi.mock("../components/ui/button", () => ({ Button: "button" }));
vi.mock("../components/ui/checkbox", () => ({ Checkbox: "input" }));

import {
  resultUsageGet,
  useResultUsageDisclosure,
  type ResultUsageDisclosureState,
} from "./resultUsage";
import {
  selectedChecksEnvironment,
  selectedChecksSessionConfirmation,
  useSelectedChecks,
  type SelectedChecksHandle,
} from "./selectedChecks";
import { SelectedChecksPanel } from "../components/chat/SelectedChecksPanel";

const USAGE_LABEL = resultUsageGet.label;
const GET_LABEL = selectedChecksEnvironment.get.label;
const CONFIRM_LABEL = selectedChecksSessionConfirmation.label;

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

function projectScript(
  id: string,
  command: string,
  icon: ProjectScript["icon"] = "lint",
): ProjectScript {
  return { id, name: id, command, icon, runOnWorktreeCreate: false };
}

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface GetEntry {
  readonly ordinal: number;
  readonly threadId: string;
  readonly deferred: Deferred<SelectedChecksGetResult>;
}

interface UsageEntry {
  readonly ordinal: number;
  readonly threadId: string;
  readonly deferred: Deferred<OwnedResultUsageOutcome>;
}

interface RpcLedger<Entry> {
  entries: Array<Entry>;
  calls: Array<{ readonly threadId: string; readonly ordinal: number }>;
}

const emptyGetResult = (): SelectedChecksGetResult => ({
  capability: { available: true, reason: null },
  record: { kind: "none" },
  changedScriptIds: [],
  admission: { state: "open" },
});

const digestHex = (seed: string) => seed.repeat(64);

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

/** Sequence must reach the receipt's anchor (5) for the passed derivation. */
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

const zeroCoverage = (): OwnedResultCoverageV1 => ({
  complete: 0,
  partial: 0,
  unavailable: 0,
  ambiguous: 0,
  conflictTainted: 0,
  unscoped: 0,
  unrecorded: 0,
  lateUnattributed: 0,
});

function okUsageOutcome(
  overrides: {
    readonly readThroughSequence?: number;
    readonly attemptId?: string;
    readonly revision?: number;
    readonly finalSequence?: number;
  } = {},
): OwnedResultUsageOutcome {
  return {
    status: "ok",
    threadId,
    readThroughSequence: overrides.readThroughSequence ?? 9,
    incarnationSequence: 0,
    barriers: { malformedReceipts: 0, invalidWindows: 0 },
    results: [
      {
        attemptId: overrides.attemptId ?? "run-attempt-1",
        revision: overrides.revision ?? 2,
        finalEventId: EventId.make("evt-final"),
        finalSequence: overrides.finalSequence ?? 7,
        anchorSequence: 6,
        segment: { fromSequenceExclusive: 5, toSequenceExclusive: 6 },
        inputs: 2,
        otherAttempts: 1,
        recordedSpan: { recordedSpanMs: 80_000, timeBasis: "recorded-event-timestamps" },
        checksMs: 30_000,
        usage: {
          status: "measured",
          coverage: { ...zeroCoverage(), complete: 2, unrecorded: 1 },
          buckets: [
            {
              scope: {
                driver: ProviderDriverKind.make("claudeAgent"),
                instanceId: ProviderInstanceId.make("inst-1"),
                nativeConversationId: null,
              },
              reportedCompleteSubtotal: {
                completeTurns: 2,
                inputTokens: 1000,
                outputTokens: 500,
                cachedInputTokens: { sum: 0, reportedTurns: 0 },
                cacheCreationTokens: { sum: 120, reportedTurns: 1 },
                reasoningTokens: { sum: 40, reportedTurns: 2 },
              },
            },
          ],
          childFrames: 3,
          legacyChildFrames: 0,
        },
        billedCost: "unknown",
        parentChildOverlap: "unknown",
      },
    ],
    trailing: { inputs: 0, otherAttempts: 0, coverage: zeroCoverage() },
  };
}

function missingCreateOutcome(readThroughSequence = 9): OwnedResultUsageOutcome {
  return { status: "missing-create", threadId, readThroughSequence };
}

function tooLargeOutcome(readThroughSequence = 9): OwnedResultUsageOutcome {
  return {
    status: "too-large",
    threadId,
    readThroughSequence,
    eventCount: 20_000,
    payloadBytes: 48_000_000,
  };
}

function makeProject(): EnvironmentProject {
  return {
    environmentId,
    id: projectId,
    title: "Project",
    workspaceRoot: "/workspace",
    defaultModelSelection: null,
    scripts: [projectScript("lint", "pnpm lint"), projectScript("test", "pnpm test", "test")],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

function makeShell(): EnvironmentThreadShell {
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

type TestBag = {
  readonly environmentId: EnvironmentIdType;
  readonly threadId: ThreadIdType;
  readonly projectId: ProjectIdType;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly catalogValueAtom: Writable<{
    isReady: boolean;
    entries: Map<EnvironmentIdType, ConnectionCatalogEntry>;
  }>;
  readonly catalogEntry: ConnectionCatalogEntry;
  readonly preparedAtom: Writable<Option.Option<PreparedConnection>>;
  readonly emptyPreparedAtom: Writable<Option.Option<PreparedConnection>>;
  readonly projectAtom: Writable<EnvironmentProject | null>;
  readonly emptyProjectAtom: Writable<EnvironmentProject | null>;
  readonly shellAtom: Writable<EnvironmentThreadShell | null>;
  readonly emptyShellAtom: Writable<EnvironmentThreadShell | null>;
  readonly detailAtom: Writable<EnvironmentThread | null>;
  readonly emptyDetailAtom: Writable<EnvironmentThread | null>;
  readonly statusAtom: Writable<EnvironmentThreadStatus>;
  readonly settingsAtom: Writable<ServerSettings>;
  readonly connectionStateAtom: Writable<AsyncResult.AsyncResult<SupervisorConnectionState>>;
  readonly testRuntime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient, never>;
  readonly setConnectionGeneration: (generation: number) => Promise<void>;
  readonly getLedger: RpcLedger<GetEntry>;
  readonly usageLedger: RpcLedger<UsageEntry>;
  readonly usageFailMode: { current: "none" | "unsupported" | "read-error" };
  readonly teardown: { current: boolean };
  readonly getEntryWaiters: Map<number, Array<Deferred<void>>>;
  readonly usageEntryWaiters: Map<number, Array<Deferred<void>>>;
  readonly resetForTest: () => Promise<void>;
};

function buildTestBag(
  authFetch: ReturnType<
    typeof vi.fn<() => Effect.Effect<AuthSessionState, unknown, EnvironmentRegistry>>
  >,
): TestBag {
  const environmentId = EnvironmentId.make("env-result-usage");
  const threadId = ThreadId.make("thread-result-usage");
  const projectId = ProjectId.make("project-1");

  // Cancelable automatic scheduling: runtime continuations run on their own
  // microtasks, so settling a controlled response drives the whole chain.
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      let canceled = false;
      queueMicrotask(() => {
        if (!canceled) task();
      });
      return () => {
        canceled = true;
      };
    },
  });

  const getLedger: RpcLedger<GetEntry> = { entries: [], calls: [] };
  const usageLedger: RpcLedger<UsageEntry> = { entries: [], calls: [] };
  const usageFailMode: TestBag["usageFailMode"] = { current: "none" };
  // Set during teardown: newly entering queued work settles immediately so
  // releasing the entries already present can never wait on fresh fixtures.
  const teardown = { current: false };
  const getEntryWaiters = new Map<number, Array<Deferred<void>>>();
  const usageEntryWaiters = new Map<number, Array<Deferred<void>>>();

  const resolveWaiters = (waiters: Map<number, Array<Deferred<void>>>, ordinal: number) => {
    const list = waiters.get(ordinal);
    if (list === undefined) return;
    waiters.delete(ordinal);
    for (const waiter of list.splice(0)) waiter.resolve();
  };

  const catalogEntry: ConnectionCatalogEntry = {
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test",
      httpBaseUrl: "https://usage.test",
      wsBaseUrl: "wss://usage.test",
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
    httpBaseUrl: "https://usage.test",
    socketUrl: "wss://usage.test",
    httpAuthorization: null,
    target: catalogEntry.target,
  };
  const preparedAtom = Atom.make(Option.some(prepared)).pipe(Atom.keepAlive);
  const emptyPreparedAtom = Atom.make(Option.none<PreparedConnection>()).pipe(Atom.keepAlive);
  const projectAtom = Atom.make<EnvironmentProject | null>(null).pipe(Atom.keepAlive);
  const emptyProjectAtom = Atom.make<EnvironmentProject | null>(null).pipe(Atom.keepAlive);
  const shellAtom = Atom.make<EnvironmentThreadShell | null>(null).pipe(Atom.keepAlive);
  const emptyShellAtom = Atom.make<EnvironmentThreadShell | null>(null).pipe(Atom.keepAlive);
  const detailAtom = Atom.make<EnvironmentThread | null>(null).pipe(Atom.keepAlive);
  const emptyDetailAtom = Atom.make<EnvironmentThread | null>(null).pipe(Atom.keepAlive);
  const statusAtom = Atom.make<EnvironmentThreadStatus>("live").pipe(Atom.keepAlive);
  const settingsAtom = Atom.make(DEFAULT_SERVER_SETTINGS).pipe(Atom.keepAlive);

  const client = {
    [WS_METHODS.selectedChecksGet]: (
      input: EnvironmentRpcInput<typeof WS_METHODS.selectedChecksGet>,
    ) => {
      const ordinal = getLedger.entries.length + 1;
      const entry: GetEntry = { ordinal, threadId: input.threadId, deferred: makeDeferred() };
      getLedger.entries.push(entry);
      getLedger.calls.push({ threadId: input.threadId, ordinal });
      resolveWaiters(getEntryWaiters, ordinal);
      if (teardown.current) return Effect.succeed(emptyGetResult());
      return Effect.promise(() => entry.deferred.promise);
    },
    [WS_METHODS.usageGetThreadResults]: (
      input: EnvironmentRpcInput<typeof WS_METHODS.usageGetThreadResults>,
    ) => {
      const ordinal = usageLedger.entries.length + 1;
      usageLedger.calls.push({ threadId: input.threadId, ordinal });
      if (teardown.current) return Effect.succeed(okUsageOutcome());
      // Entry is recorded before every return path, including fixed failures.
      const entry: UsageEntry = { ordinal, threadId: input.threadId, deferred: makeDeferred() };
      if (usageFailMode.current === "unsupported") {
        usageLedger.entries.push(entry);
        resolveWaiters(usageEntryWaiters, ordinal);
        return Effect.fail(`Unknown request tag: ${WS_METHODS.usageGetThreadResults}`);
      }
      if (usageFailMode.current === "read-error") {
        usageLedger.entries.push(entry);
        resolveWaiters(usageEntryWaiters, ordinal);
        return Effect.fail(
          new OwnedResultUsageReadError({
            reason: "scanFailed",
            detail: OWNED_RESULT_USAGE_READ_ERROR_DETAIL,
          }),
        );
      }
      usageLedger.entries.push(entry);
      resolveWaiters(usageEntryWaiters, ordinal);
      return Effect.promise(() => entry.deferred.promise);
    },
  };

  const makeRpcSession = (): RpcSession => ({
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
      session: yield* SubscriptionRef.make(Option.some(makeRpcSession())),
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
        Promise.reject(new Error("Unexpected HttpClient fetch in result-usage tests.")),
      ),
    ),
  );

  const resetFixtureCommand = createRuntimeCommand(testRuntime, {
    label: "result-usage-test.reset-fixture",
    execute: (_void: void, runtimeRegistry) =>
      Effect.gen(function* () {
        supervisors.clear();
        const envReg = yield* EnvironmentRegistry;
        yield* SubscriptionRef.set(
          envReg.entries,
          new Map<EnvironmentIdType, ConnectionCatalogEntry>([[environmentId, catalogEntry]]),
        );
        runtimeRegistry.set(connectionStateAtom, AsyncResult.success(connectedState()));
        runtimeRegistry.set(preparedAtom, Option.some(prepared));
      }),
  });

  const setConnectionGenerationCommand = createRuntimeCommand(testRuntime, {
    label: "result-usage-test.set-connection-generation",
    execute: ({ generation }: { readonly generation: number }, runtimeRegistry) =>
      Effect.gen(function* () {
        runtimeRegistry.set(connectionStateAtom, AsyncResult.success(connectedState(generation)));
        const supervisor = yield* ensureSupervisor;
        yield* SubscriptionRef.update(supervisor.state, (state) => ({
          ...state,
          generation,
          phase: "connected" as const,
        }));
      }),
  });

  const runFixture = async <W, A, E>(command: AtomCommand<W, A, E>, input: W): Promise<A> => {
    const result = await runAtomCommand(registry, command, input, {
      reportFailure: false,
      reportDefect: false,
    });
    if (result._tag !== "Success") {
      throw new Error(`Fixture command ${command.label} failed`);
    }
    return result.value;
  };

  const resetForTest = async () => {
    for (const entry of getLedger.entries) entry.deferred.resolve(emptyGetResult());
    for (const entry of usageLedger.entries) entry.deferred.resolve(okUsageOutcome());
    getLedger.entries.length = 0;
    getLedger.calls.length = 0;
    usageLedger.entries.length = 0;
    usageLedger.calls.length = 0;
    getEntryWaiters.clear();
    usageEntryWaiters.clear();
    usageFailMode.current = "none";
    teardown.current = false;
    await runFixture(resetFixtureCommand, undefined);
    registry.set(connectionStateAtom, AsyncResult.success(connectedState()));
    registry.set(preparedAtom, Option.some(prepared));
    registry.set(projectAtom, null);
    registry.set(shellAtom, null);
    registry.set(detailAtom, null);
    registry.set(statusAtom, "live");
    registry.set(settingsAtom, DEFAULT_SERVER_SETTINGS);
    authFetch.mockReset();
    authFetch.mockImplementation(() => Effect.succeed(OPERATE_SESSION));
  };

  const setConnectionGeneration = async (generation: number) => {
    await runFixture(setConnectionGenerationCommand, { generation });
  };

  return {
    environmentId,
    threadId,
    projectId,
    registry,
    catalogValueAtom,
    catalogEntry,
    preparedAtom,
    emptyPreparedAtom,
    projectAtom,
    emptyProjectAtom,
    shellAtom,
    emptyShellAtom,
    detailAtom,
    emptyDetailAtom,
    statusAtom,
    settingsAtom,
    connectionStateAtom,
    testRuntime,
    setConnectionGeneration,
    getLedger,
    usageLedger,
    usageFailMode,
    teardown,
    getEntryWaiters,
    usageEntryWaiters,
    resetForTest,
  };
}

/** The mocked session read fails with this, as the real read fails with a tagged error. */
class AuthFetchError extends Data.TaggedError("AuthFetchError")<{ readonly cause: unknown }> {}

const root = vi.hoisted(() => {
  const authFetch =
    vi.fn<() => Effect.Effect<AuthSessionState, AuthFetchError, EnvironmentRegistry>>();
  let bag: TestBag | undefined;
  return {
    authFetch,
    getBag: async () => {
      bag ??= buildTestBag(authFetch);
      return bag;
    },
  };
});

let bag!: TestBag;
let environmentId!: EnvironmentIdType;
let threadId!: ThreadIdType;
let projectId!: ProjectIdType;

let renderer: ReactTestRenderer | undefined;
let latestChecks!: SelectedChecksHandle;
let latestResultUsage!: ReturnType<typeof useResultUsageDisclosure>;
const stateHistory: ResultUsageDisclosureState[] = [];
let pendingAuth: Deferred<AuthSessionState> | null = null;
let domTeardown: () => void = () => {};

/**
 * The controller stays mounted across leaf flips, so an already-open
 * confirmed record survives a later usage-hook mount.
 */
function Probe({ usageLeaf }: { readonly usageLeaf: boolean }) {
  const checks = useSelectedChecks({
    environmentId,
    threadId,
    project: makeProject(),
    candidates: [projectScript("lint", "pnpm lint"), projectScript("test", "pnpm test", "test")],
  });
  useLayoutEffect(() => {
    latestChecks = checks;
  }, [checks]);
  if (!usageLeaf) return null;
  return createElement(ChecksBody, { checks });
}

/** The real hook plus the real panel; mounts fresh when the leaf flips on. */
function ChecksBody({ checks }: { readonly checks: SelectedChecksHandle }) {
  const resultUsage = useResultUsageDisclosure({
    identity: checks.recordIdentity,
    readRecordIdentity: checks.readRecordIdentity,
    open: checks.view.open,
  });
  useLayoutEffect(() => {
    latestResultUsage = resultUsage;
    stateHistory.push(resultUsage.state);
  }, [checks, resultUsage]);
  // Same wiring as SelectedChecksControl in ChatHeader.
  return createElement(SelectedChecksPanel, {
    open: checks.view.open,
    onOpenChange: (next: boolean) => {
      if (!next) checks.closePanel();
    },
    view: checks.view,
    candidates: checks.candidates,
    threadId,
    threadTitle: "Thread",
    permission: checks.permission,
    permissionStatus: checks.permissionStatus,
    onRetryPermission: checks.retryPermission,
    onToggle: checks.toggle,
    onRefresh: () => {
      checks.refresh();
      resultUsage.refresh();
    },
    onRun: checks.run,
    onStop: checks.stop,
    onRecheck: checks.recheck,
    onOpenRecoveryDialog: checks.openRecoveryDialog,
    onCloseRecoveryDialog: checks.closeRecoveryDialog,
    onSubmitRecovery: checks.submitRecoveryDialog,
    resultUsage: resultUsage.state,
  });
}

function renderTree(strict: boolean, usageLeaf: boolean) {
  const tree = createElement(
    RegistryContext.Provider,
    { value: bag.registry },
    createElement(Probe, { usageLeaf }),
  );
  const mounted = strict ? createElement(StrictMode, null, tree) : tree;
  if (renderer === undefined) renderer = create(mounted);
  else renderer.update(mounted);
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
  domTeardown = () => listeners.clear();
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

/**
 * The exact promise the hook's own command call returned, by label and call
 * order. The hook registered its settlement continuation first, so once this
 * resolves inside act, the settlement and the committed render have happened.
 */
function completion(label: string, ordinal: number): Promise<unknown> {
  const promise = recorded.completions
    .filter((entry) => entry.label === label)
    .map((entry) => entry.promise)[ordinal - 1];
  if (promise === undefined) throw new Error(`no completion #${ordinal} for ${label}`);
  return promise;
}

/** Resolves once that request ordinal has entered the controlled client. */
async function onGetEntered(ordinal: number): Promise<void> {
  if (bag.getLedger.entries.some((entry) => entry.ordinal === ordinal)) return;
  const waiter = makeDeferred<void>();
  const list = bag.getEntryWaiters.get(ordinal) ?? [];
  list.push(waiter);
  bag.getEntryWaiters.set(ordinal, list);
  await waiter.promise;
}

/** Resolves once that usage request ordinal has entered the controlled client. */
async function onUsageEntered(ordinal: number): Promise<void> {
  if (bag.usageLedger.entries.some((entry) => entry.ordinal === ordinal)) return;
  const waiter = makeDeferred<void>();
  const list = bag.usageEntryWaiters.get(ordinal) ?? [];
  list.push(waiter);
  bag.usageEntryWaiters.set(ordinal, list);
  await waiter.promise;
}

const textOf = (node: ReactTestInstance | string): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");

const rootText = () => textOf(renderer!.root);

async function settleGet(ordinal: number, result: SelectedChecksGetResult) {
  const entry = bag.getLedger.entries.find((candidate) => candidate.ordinal === ordinal);
  if (entry === undefined) throw new Error(`no get entry ${ordinal}`);
  await act(async () => {
    entry.deferred.resolve(result);
    await completion(GET_LABEL, ordinal);
  });
}

async function settleUsage(ordinal: number, outcome: OwnedResultUsageOutcome) {
  const entry = bag.usageLedger.entries.find((candidate) => candidate.ordinal === ordinal);
  if (entry === undefined) throw new Error(`no usage entry ${ordinal}`);
  await act(async () => {
    entry.deferred.resolve(outcome);
    await completion(USAGE_LABEL, ordinal);
  });
}

/** Resolves the reconfirm auth for one confirm call, deterministically. */
async function resolveAuth(ordinal: number, session: AuthSessionState = OPERATE_SESSION) {
  if (pendingAuth === null) throw new Error("queueAuth() before resolveAuth()");
  await act(async () => {
    pendingAuth!.resolve(session);
    pendingAuth = null;
    await completion(CONFIRM_LABEL, ordinal);
  });
}

/** Opens the panel, lands the get on the passed record, awaits the usage read. */
async function openPassedPanel(getOrdinal: number, passedOverrides: { sequence?: number } = {}) {
  await act(() => latestChecks.openPanel());
  await onGetEntered(getOrdinal);
  await settleGet(getOrdinal, presentPassedGet(passedOverrides));
  if (latestChecks.view.headline !== "passed") {
    throw new Error(`expected passed headline, got ${latestChecks.view.headline}`);
  }
}

/**
 * Settles the gets a reconfirm refresh actually issued, in entry order: the
 * reconcile get, then the queued post-reconfirm re-get that alone lands at
 * the current generation. Each ordinal is awaited as an entry receipt.
 */
async function settleEnteredGets(
  first: number,
  result: SelectedChecksGetResult,
  count: number,
): Promise<void> {
  for (let offset = 0; offset < count; offset++) {
    await onGetEntered(first + offset);
    await settleGet(first + offset, result);
  }
}

const refreshButton = (): ReactTestInstance | undefined =>
  renderer!.root.findAllByType("button").find((node) => textOf(node) === "Refresh");

const disclosureSummary = (): ReactTestInstance | undefined =>
  renderer!.root
    .findAllByType("summary")
    .find((node) => textOf(node).includes("이 결과까지의 사용량"));

/** The usage disclosure's controlled details element (the verdict details has no open prop). */
const disclosureDetails = (): ReactTestInstance | undefined =>
  renderer!.root.findAllByType("details").find((node) => "open" in node.props);

async function mountConfirmed(strict = false) {
  bag.registry.set(bag.projectAtom, makeProject());
  bag.registry.set(bag.shellAtom, makeShell());
  bag.registry.set(bag.detailAtom, makeThreadDetail());
  bag.registry.set(bag.statusAtom, "live");
  await bag.setConnectionGeneration(1);
  queueAuth();
  await act(async () => {
    renderTree(strict, !strict);
  });
  await resolveAuth(1);
  if (latestChecks.permissionStatus !== "confirmed") {
    throw new Error("permission not confirmed after the confirm receipt");
  }
}

beforeEach(async () => {
  bag = await root.getBag();
  await bag.resetForTest();
  environmentId = bag.environmentId;
  threadId = bag.threadId;
  projectId = bag.projectId;
  recorded.completions.length = 0;
  stateHistory.length = 0;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stubDom();
});

afterEach(async () => {
  // Unmount first: hook callbacks can no longer drive new work after this.
  await act(() => renderer?.unmount());
  renderer = undefined;
  bag.teardown.current = true;
  await act(async () => {
    // Settle any pending reconfirm auth, release the controlled responses
    // already present, and let newly entering queued work succeed at once;
    // then await the actual command receipts.
    if (pendingAuth !== null) {
      pendingAuth.resolve(OPERATE_SESSION);
      pendingAuth = null;
    }
    for (const entry of bag.getLedger.entries) entry.deferred.resolve(emptyGetResult());
    for (const entry of bag.usageLedger.entries) entry.deferred.resolve(okUsageOutcome());
    await Promise.allSettled(recorded.completions.map((entry) => entry.promise));
  });
  domTeardown();
  vi.unstubAllGlobals();
});

describe("result usage disclosure", () => {
  it("requests nothing while closed or unpassed, then one scoped read shows the exact row", async () => {
    await mountConfirmed();
    expect(bag.usageLedger.entries).toHaveLength(0);

    // Open onto a record that is not passed: still no usage read.
    await act(() => latestChecks.openPanel());
    await onGetEntered(1);
    await settleGet(1, emptyGetResult());
    expect(latestChecks.view.headline).toBe("none");
    expect(bag.usageLedger.entries).toHaveLength(0);

    queueAuth();
    await act(() => latestChecks.refresh());
    await resolveAuth(2);
    await settleEnteredGets(2, presentPassedGet(), 2);
    expect(latestChecks.view.headline).toBe("passed");
    expect(latestChecks.recordIdentity).toMatchObject({
      environmentId,
      threadId,
      attemptId: "run-attempt-1",
      revision: 2,
      receiptSequence: 7,
    });

    await onUsageEntered(1);
    expect(bag.usageLedger.calls).toEqual([{ threadId, ordinal: 1 }]);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });
    expect(rootText()).toContain("사용량 기록을 읽는 중…");

    await settleUsage(1, okUsageOutcome());
    expect(latestResultUsage.state).toMatchObject({
      phase: "row",
      readThroughSequence: 9,
    });
    const summary = disclosureSummary();
    expect(summary).toBeDefined();
    expect(disclosureDetails()!.props.open).toBe(false);
    // Component state transitions; the parent browser pass separately proves
    // native pointer/default-action behavior for opening and closing.
    await act(() => summary!.props.onClick({ preventDefault: () => {} }));
    expect(disclosureDetails()!.props.open).toBe(true);
    const text = rootText();
    expect(text).toContain("이 스레드 · 이 서버가 기록한 값");
    expect(text).toContain("입력 1000 · 출력 500");
    expect(text).toContain("캐시 입력 미보고");
    expect(text).toContain("캐시 생성 120(1/2턴 보고)");
    expect(text).toContain("하위 작업 3 frame · 미포함(중복 여부 불명)");
    expect(text).toContain("비용: 알 수 없음(청구액 기록 없음)");
    expect(text).toContain(
      "기록 시각 차이: 1분 20초(기록된 시각의 차이이며 실제 실행 시간이 아님)",
    );
    await act(() => summary!.props.onClick({ preventDefault: () => {} }));
    expect(disclosureDetails()!.props.open).toBe(false);
  });

  it("rejects a held response whose row finalSequence differs from the displayed receipt even at head 100", async () => {
    await mountConfirmed();
    // Displayed record: same attempt/revision, receipt row at sequence 8.
    await openPassedPanel(1, { sequence: 8 });
    await onUsageEntered(1);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    // Old row captured at finalSequence 7 under a head that covers 8.
    await settleUsage(1, okUsageOutcome({ readThroughSequence: 100, finalSequence: 7 }));
    expect(latestResultUsage.state).toEqual({ phase: "row-missing" });
    expect(rootText()).not.toContain("입력 1000");
    expect(rootText()).toContain("새로고침해 주세요");
  });

  it("marks the read stale immediately when the record moves to a newer revision and ignores the held response", async () => {
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    queueAuth();
    await act(() => latestChecks.refresh());
    await resolveAuth(2);
    await settleEnteredGets(2, presentPassedGet({ revision: 3, sequence: 8 }), 2);
    if (latestChecks.recordIdentity?.revision !== 3) {
      throw new Error("displayed record did not move to revision 3");
    }
    // Drift committed: stale at once — no spinner for a request that will
    // never be accepted, and no numbers.
    expect(latestResultUsage.state).toEqual({ phase: "row-missing" });

    await settleUsage(1, okUsageOutcome({ readThroughSequence: 9 }));
    expect(latestResultUsage.state).toEqual({ phase: "row-missing" });
    expect(bag.usageLedger.entries).toHaveLength(1);
    expect(stateHistory.some((entry) => entry.phase === "row")).toBe(false);

    // Explicit combined refresh (panel handler) rearms usage; the exact
    // rev-3 row displays.
    queueAuth();
    await act(() => refreshButton()!.props.onClick());
    await resolveAuth(3);
    await settleEnteredGets(4, presentPassedGet({ revision: 3, sequence: 8 }), 2);
    await onUsageEntered(2);
    await settleUsage(
      2,
      okUsageOutcome({ revision: 3, finalSequence: 8, readThroughSequence: 30 }),
    );
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 30 });
    expect(rootText()).toContain("입력 1000");
  });

  it("marks the read stale after a connection-authority change with identical identifiers and ignores the held response", async () => {
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    queueAuth();
    await act(async () => {
      await bag.setConnectionGeneration(2);
    });
    await resolveAuth(2);
    await settleEnteredGets(2, presentPassedGet(), 2);
    expect(latestChecks.view.headline).toBe("passed");
    expect(latestChecks.recordIdentity).toMatchObject({ stamp: { generation: 2 } });
    expect(latestResultUsage.state).toEqual({ phase: "row-missing" });

    // The response captured under generation 1 is never displayed.
    await settleUsage(1, okUsageOutcome({ readThroughSequence: 9 }));
    expect(latestResultUsage.state).toEqual({ phase: "row-missing" });
    expect(bag.usageLedger.entries).toHaveLength(1);
    expect(stateHistory.some((entry) => entry.phase === "row")).toBe(false);

    // Explicit combined refresh (panel handler) rearms usage.
    queueAuth();
    await act(() => refreshButton()!.props.onClick());
    await resolveAuth(3);
    await settleEnteredGets(4, presentPassedGet(), 2);
    await onUsageEntered(2);
    await settleUsage(2, okUsageOutcome({ readThroughSequence: 30 }));
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 30 });
  });

  it("marks the read stale when the thread disappears and reappears with the same identifiers", async () => {
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    await act(async () => {
      bag.registry.set(bag.shellAtom, null);
      bag.registry.set(bag.statusAtom, "deleted");
    });
    expect(latestResultUsage.state).toEqual({ phase: "hidden" });

    await act(async () => {
      bag.registry.set(bag.shellAtom, makeShell());
      bag.registry.set(bag.statusAtom, "live");
    });
    await settleEnteredGets(2, presentPassedGet(), 1);
    expect(latestChecks.view.headline).toBe("passed");
    expect(latestChecks.recordIdentity).toMatchObject({ incarnation: 1 });
    expect(latestResultUsage.state).toEqual({ phase: "row-missing" });

    await settleUsage(1, okUsageOutcome({ readThroughSequence: 9 }));
    expect(latestResultUsage.state).toEqual({ phase: "row-missing" });
    expect(bag.usageLedger.entries).toHaveLength(1);
    expect(stateHistory.some((entry) => entry.phase === "row")).toBe(false);
  });

  it("hides numbers synchronously on refresh, ignores the superseded response, and shows only the new read", async () => {
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);

    // Refresh while #1 is pending, with the reconfirm auth held so the
    // post-click commit is deterministic: numbers are gone at once.
    queueAuth();
    await act(() => refreshButton()!.props.onClick());
    expect(latestResultUsage.state).toEqual({ phase: "hidden" });
    await resolveAuth(2);
    await settleEnteredGets(2, presentPassedGet(), 2);
    await onUsageEntered(2);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    // Release the superseded #1: dropped by its token, still pending.
    await settleUsage(1, okUsageOutcome({ readThroughSequence: 9 }));
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    await settleUsage(2, okUsageOutcome({ readThroughSequence: 30 }));
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 30 });

    // Refresh from an accepted row: the old numbers disappear before the
    // held new read is released.
    queueAuth();
    await act(() => refreshButton()!.props.onClick());
    expect(latestResultUsage.state).toEqual({ phase: "hidden" });
    expect(stateHistory.at(-1)!.phase).not.toBe("row");
    await resolveAuth(3);
    await settleEnteredGets(4, presentPassedGet(), 2);
    await onUsageEntered(3);
    await settleUsage(3, okUsageOutcome({ readThroughSequence: 40 }));
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 40 });
  });

  it("keeps the armed read waiting through an auth-confirmed re-read and issues one fresh request", async () => {
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);
    await settleUsage(1, okUsageOutcome());
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 9 });

    // Browser race: hold the reconfirm auth, settle the refresh's first get
    // before the auth completes, then confirm. The confirmed render makes the
    // view eligible while the controller's own re-read is still pending.
    queueAuth();
    await act(() => refreshButton()!.props.onClick());
    expect(latestResultUsage.state).toEqual({ phase: "hidden" });
    await settleGet(2, presentPassedGet());
    // No new usage request while permission is still checking.
    expect(bag.usageLedger.entries).toHaveLength(1);
    await resolveAuth(2);
    await onGetEntered(3);
    // No fresh identity is available while get 3 is held; the disclosure
    // stays hidden and the unissued read remains armed.
    expect(latestResultUsage.state).toEqual({ phase: "hidden" });
    expect(bag.usageLedger.entries).toHaveLength(1);
    expect(rootText()).not.toContain("입력 1000");

    await settleGet(3, presentPassedGet());
    await onUsageEntered(2);
    expect(bag.usageLedger.entries).toHaveLength(2);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    await settleUsage(2, okUsageOutcome({ readThroughSequence: 30 }));
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 30 });
  });

  it("hides immediately on close, issues a new request on reopen, and ignores the pre-close response", async () => {
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);

    await act(() => latestChecks.closePanel());
    expect(latestResultUsage.state).toEqual({ phase: "hidden" });

    await openPassedPanel(2);
    await onUsageEntered(2);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    // Every identity scalar matches, but the pre-close response stays dropped.
    await settleUsage(1, okUsageOutcome({ readThroughSequence: 9 }));
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    await settleUsage(2, okUsageOutcome({ readThroughSequence: 30 }));
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 30 });
  });

  it("preserves the fixed non-row outcomes from successful bound reads", async () => {
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);
    await settleUsage(1, missingCreateOutcome());
    expect(latestResultUsage.state).toEqual({ phase: "missing-create" });
    expect(rootText()).toContain("스레드 생성 기록을 찾을 수 없어 사용량을 읽을 수 없습니다.");

    queueAuth();
    await act(() => refreshButton()!.props.onClick());
    await resolveAuth(2);
    await settleEnteredGets(2, presentPassedGet(), 2);
    await onUsageEntered(2);
    await settleUsage(2, tooLargeOutcome(30));
    expect(latestResultUsage.state).toEqual({ phase: "too-large" });
    expect(rootText()).toContain("스레드 기록이 너무 커서 사용량을 읽을 수 없습니다.");
  });

  it("shows fixed failure copy for a read error without raw causes", async () => {
    bag.usageFailMode.current = "read-error";
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);
    await act(async () => {
      await completion(USAGE_LABEL, 1);
    });
    expect(latestResultUsage.state).toEqual({ phase: "read-failed" });
    const text = rootText();
    expect(text).toContain("사용량 기록을 읽을 수 없습니다.");
    expect(text).not.toContain("scanFailed");
    expect(text).not.toContain("Could not read thread history.");
    expect(text).not.toContain("입력 1000");
    expect(bag.usageLedger.entries).toHaveLength(1);
  });

  it("shows fixed unsupported copy for old servers without retrying", async () => {
    bag.usageFailMode.current = "unsupported";
    await mountConfirmed();
    await openPassedPanel(1);
    await onUsageEntered(1);
    await act(async () => {
      await completion(USAGE_LABEL, 1);
    });
    expect(latestResultUsage.state).toEqual({ phase: "unsupported" });
    expect(rootText()).toContain("이 서버 버전은 결과별 사용량 읽기를 지원하지 않습니다.");
    expect(rootText()).not.toContain("입력 1000");
    await act(async () => {});
    expect(bag.usageLedger.entries).toHaveLength(1);
  });

  it("issues exactly one usage request when the hook first mounts eligible under StrictMode", async () => {
    // Mount with no usage hook at all, land the open confirmed passed
    // record, then flip the leaf so the real usage hook's first mount is
    // eligible under StrictMode: the setup replay must not issue the armed
    // read twice, and the held read must still display after release.
    await mountConfirmed(true);
    await act(() => latestChecks.openPanel());
    await onGetEntered(1);
    await settleGet(1, presentPassedGet());
    expect(bag.usageLedger.entries).toHaveLength(0);

    await act(() => renderTree(true, true));
    await onUsageEntered(1);
    expect(bag.usageLedger.entries).toHaveLength(1);
    expect(latestResultUsage.state).toEqual({ phase: "loading" });

    await settleUsage(1, okUsageOutcome());
    expect(latestResultUsage.state).toMatchObject({ phase: "row", readThroughSequence: 9 });
  });
});
