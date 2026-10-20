import {
  EnvironmentId,
  ThreadId,
  WS_METHODS,
  type TaskResultGetResult,
  type TaskResultRejectedError,
  type TaskResultThreadNotFoundError,
} from "@t3tools/contracts";
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
  AtomCommand,
  AtomCommandOptions,
  AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { useRef } from "react";

/**
 * Shared real-command fixture for task-result tests. Production commands are
 * never substituted: the runtime is swapped for an owned Atom.runtime whose
 * EnvironmentRegistry runs the real RPC effect against a controlled session
 * client. Responses live only in the session handlers below.
 */

export type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

export function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export interface TaskResultRpcEntry {
  /** Order across every task-result method, 1-based. */
  readonly ordinal: number;
  /** Order within this method, 1-based. */
  readonly methodOrdinal: number;
  readonly method: string;
  readonly input: unknown;
  readonly deferred: Deferred<TaskResultGetResult>;
}

export interface TaskResultRpcCall {
  readonly method: string;
  readonly input: unknown;
}

export interface TaskResultTestBag {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly testRuntime: Atom.AtomRuntime<EnvironmentRegistry, never>;
  readonly rpcEntries: Array<TaskResultRpcEntry>;
  readonly rpcCalls: Array<TaskResultRpcCall>;
  readonly recorded: {
    readonly completions: Array<{ readonly label: string; readonly promise: Promise<unknown> }>;
  };
  readonly setFailure: { current: TaskResultRejectedError | null };
  readonly getFailure: { current: TaskResultThreadNotFoundError | null };
  /** Set during teardown: newly entering queued work settles immediately. */
  readonly teardown: { current: boolean };
  readonly emptyGetResult: TaskResultGetResult;
  readonly waitForCall: (method: string, methodOrdinal: number) => Promise<void>;
}

export function buildTaskResultTestBag(): TaskResultTestBag {
  const environmentId = EnvironmentId.make("env-task-result");
  const threadId = ThreadId.make("thread-task-result");

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

  const rpcEntries: Array<TaskResultRpcEntry> = [];
  const rpcCalls: Array<TaskResultRpcCall> = [];
  const recorded = {
    completions: [] as Array<{ label: string; promise: Promise<unknown> }>,
  };
  const setFailure = { current: null as TaskResultRejectedError | null };
  const getFailure = { current: null as TaskResultThreadNotFoundError | null };
  const teardown = { current: false };
  const entryWaiters = new Map<string, Array<Deferred<void>>>();

  const emptyGetResult: TaskResultGetResult = {
    record: { kind: "none" },
    threadIncarnation: 2,
    checks: {
      capability: { available: true, reason: null },
      record: { kind: "none" },
      changedScriptIds: [],
      admission: { state: "open" },
      treeUnchanged: true,
      environmentMatches: true,
      contextMatches: true,
    },
  };

  const resolveWaiters = (method: string, methodOrdinal: number) => {
    const list = entryWaiters.get(`${method}#${methodOrdinal}`);
    if (list === undefined) return;
    entryWaiters.delete(`${method}#${methodOrdinal}`);
    for (const waiter of list.splice(0)) waiter.resolve();
  };

  const waitForCall = (method: string, methodOrdinal: number): Promise<void> => {
    if (rpcCalls.filter((call) => call.method === method).length >= methodOrdinal) {
      return Promise.resolve();
    }
    const waiter = makeDeferred<void>();
    const key = `${method}#${methodOrdinal}`;
    const list = entryWaiters.get(key) ?? [];
    list.push(waiter);
    entryWaiters.set(key, list);
    return waiter.promise;
  };

  const recordCall = (method: string, input: unknown): TaskResultRpcEntry => {
    const entry: TaskResultRpcEntry = {
      ordinal: rpcEntries.length + 1,
      methodOrdinal: rpcCalls.filter((call) => call.method === method).length + 1,
      method,
      input,
      deferred: makeDeferred<TaskResultGetResult>(),
    };
    rpcEntries.push(entry);
    rpcCalls.push({ method, input });
    resolveWaiters(method, entry.methodOrdinal);
    return entry;
  };

  const client = {
    [WS_METHODS.taskResultGet]: (input: EnvironmentRpcInput<typeof WS_METHODS.taskResultGet>) => {
      const entry = recordCall(WS_METHODS.taskResultGet, input);
      if (teardown.current) return Effect.succeed(emptyGetResult);
      if (getFailure.current !== null) return Effect.fail(getFailure.current);
      return Effect.promise(() => entry.deferred.promise);
    },
    [WS_METHODS.taskResultSetRequirements]: (
      input: EnvironmentRpcInput<typeof WS_METHODS.taskResultSetRequirements>,
    ) => {
      const entry = recordCall(WS_METHODS.taskResultSetRequirements, input);
      if (teardown.current) return Effect.succeed(emptyGetResult);
      if (setFailure.current !== null) return Effect.fail(setFailure.current);
      return Effect.promise(() => entry.deferred.promise);
    },
    [WS_METHODS.taskResultAccept]: (
      input: EnvironmentRpcInput<typeof WS_METHODS.taskResultAccept>,
    ) => {
      const entry = recordCall(WS_METHODS.taskResultAccept, input);
      if (teardown.current) return Effect.succeed(emptyGetResult);
      return Effect.promise(() => entry.deferred.promise);
    },
    [WS_METHODS.taskResultWithdraw]: (
      input: EnvironmentRpcInput<typeof WS_METHODS.taskResultWithdraw>,
    ) => {
      const entry = recordCall(WS_METHODS.taskResultWithdraw, input);
      if (teardown.current) return Effect.succeed(emptyGetResult);
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

  const catalogEntry: ConnectionCatalogEntry = {
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Test",
      httpBaseUrl: "https://task-result.test",
      wsBaseUrl: "wss://task-result.test",
    }),
    profile: Option.none(),
    enabled: true,
  };

  const connectedState = (): SupervisorConnectionState => ({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  });

  const prepared: PreparedConnection = {
    environmentId,
    label: "Test",
    httpBaseUrl: "https://task-result.test",
    socketUrl: "wss://task-result.test",
    httpAuthorization: null,
    target: catalogEntry.target,
  };

  const supervisors = new Map<EnvironmentId, EnvironmentSupervisor["Service"]>();

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
    id: EnvironmentId,
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
        ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
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

  const testRuntime = Atom.runtime(registryLayer);

  return {
    environmentId,
    threadId,
    registry,
    testRuntime,
    rpcEntries,
    rpcCalls,
    recorded,
    setFailure,
    getFailure,
    teardown,
    emptyGetResult,
    waitForCall,
  };
}

let cachedBag: TaskResultTestBag | undefined;

export function getTaskResultBag(): TaskResultTestBag {
  cachedBag ??= buildTaskResultTestBag();
  return cachedBag;
}

/**
 * Wraps the real useAtomCommand: every call records the exact promise the
 * hook awaits, by command label and call order. No command is substituted and
 * no tag-specific branch may skip `run(value)`.
 */
export function wrapUseAtomCommand(
  original: typeof import("./use-atom-command"),
  bag: TaskResultTestBag,
): typeof import("./use-atom-command") {
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
          bag.recorded.completions.push({ label: command.label, promise });
          return promise;
        };
      }
      return stable.current;
    },
  };
}

/**
 * The exact promise the hook's own command call returned, by label and call
 * order. The hook registered its settlement continuation first, so once this
 * resolves inside act, the settlement and the committed render have happened.
 */
export function completion(
  bag: TaskResultTestBag,
  label: string,
  ordinal: number,
): Promise<unknown> {
  const promise = bag.recorded.completions
    .filter((entry) => entry.label === label)
    .map((entry) => entry.promise)[ordinal - 1];
  if (promise === undefined) throw new Error(`no completion #${ordinal} for ${label}`);
  return promise;
}

export function entriesOf(bag: TaskResultTestBag, method: string): Array<TaskResultRpcEntry> {
  return bag.rpcEntries.filter((entry) => entry.method === method);
}

export function callsOf(bag: TaskResultTestBag, method: string): Array<unknown> {
  return bag.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
}

/** Mark teardown, release held session responses, and drain command receipts. */
export async function drainTaskResultBag(bag: TaskResultTestBag): Promise<void> {
  bag.teardown.current = true;
  for (const entry of bag.rpcEntries) entry.deferred.resolve(bag.emptyGetResult);
  await Promise.allSettled(bag.recorded.completions.map((entry) => entry.promise));
}
