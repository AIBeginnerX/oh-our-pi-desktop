// @effect-diagnostics globalDate:off -- Latches alone sequence these tests.
import {
  EnvironmentId,
  ProjectId,
  ProjectMemoryNotFoundError,
  ProjectMemoryStoreError,
  ThreadId,
  WS_METHODS,
  type ProjectId as ProjectIdType,
  type ProjectMemoryId,
  type ProjectMemorySummary,
  type ProjectMemoryThreadState,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createProjectMemoryAtoms } from "./projectMemory.ts";
import { runAtomCommand } from "./runtime.ts";

const ENVIRONMENT = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("memory-environment"),
  label: "Memory environment",
  httpBaseUrl: "https://memory.example.test",
  wsBaseUrl: "wss://memory.example.test",
});

const ENVIRONMENT_ID = ENVIRONMENT.environmentId;

function connectionState(): SupervisorConnectionState {
  return {
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    network: "online",
    phase: "connected",
    attempt: 1,
    generation: 1,
  };
}

function makeSession(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.empty,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

const EMPTY_THREAD_STATE: ProjectMemoryThreadState = {
  held: false,
  latestChangeSeq: null,
  acknowledgedThrough: 0,
  changes: [],
  mayHaveMore: false,
};

/**
 * An in-memory memory store behind the `projectMemory.*` wire tags. The list
 * endpoint arms `armListRefetch` to open a latch at the given call count,
 * `armListFailure` fails list calls from one on, and `holdListsFor` holds a
 * project's list responses until `releaseHeld`, so tests await exactly the
 * fetches and failures a write's invalidation triggers. The thread-state
 * endpoints expose the same latch/hold/failure seams (`armThreadStateRefetch`,
 * `armThreadStateFailure`, `holdThreadStateFor`) plus per-input call counts
 * and the raw acknowledge inputs each command put on the wire.
 */
function makeMemoryClient() {
  const projects = new Map<string, Map<string, { title: string; version: number }>>();
  const storeFor = (projectId: ProjectIdType) => {
    let store = projects.get(projectId);
    if (store === undefined) {
      store = new Map();
      projects.set(projectId, store);
    }
    return store;
  };
  let listCalls = 0;
  let refetchLatch = Latch.makeUnsafe();
  let refetchThreshold = Number.POSITIVE_INFINITY;
  let failListFromCall = Number.POSITIVE_INFINITY;
  let heldProject: ProjectIdType | null = null;
  const releaseHeld = Latch.makeUnsafe();
  const firstListStarted = Latch.makeUnsafe();
  const threadStates = new Map<string, ProjectMemoryThreadState>();
  let threadStateCalls = 0;
  const threadStateCallsByKey = new Map<string, number>();
  let threadStateRefetchThreshold = Number.POSITIVE_INFINITY;
  let threadStateRefetchLatch = Latch.makeUnsafe();
  let failThreadStateFromCall = Number.POSITIVE_INFINITY;
  let heldThreadStateProject: ProjectIdType | null = null;
  const releaseHeldThreadState = Latch.makeUnsafe();
  const ackInputs: Array<{
    projectId: ProjectIdType;
    threadId: string;
    throughChangeSeq: number;
  }> = [];

  const threadKey = (projectId: ProjectIdType, threadId: string) => `${projectId}:${threadId}`;
  const threadStateResult = (input: { projectId: ProjectIdType; threadId: string }) =>
    Effect.succeed(
      threadStates.get(threadKey(input.projectId, input.threadId)) ?? EMPTY_THREAD_STATE,
    );

  const summary = (projectId: ProjectIdType, memoryId: string): ProjectMemorySummary => {
    const memory = storeFor(projectId).get(memoryId);
    return {
      memoryId: memoryId as ProjectMemoryId,
      projectId,
      kind: "fact",
      title: memory?.title ?? "",
      version: memory?.version ?? 1,
      origin: { type: "manual" },
      validUntil: null,
      estimatedTokens: 1,
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    };
  };
  const listResult = (projectId: ProjectIdType) =>
    Effect.succeed({
      items: [...storeFor(projectId).keys()].map((memoryId) => summary(projectId, memoryId)),
      truncated: false,
    });

  const client = {
    [WS_METHODS.projectMemoryList]: (input: { projectId: ProjectIdType }) => {
      listCalls += 1;
      firstListStarted.openUnsafe();
      if (listCalls >= refetchThreshold) refetchLatch.openUnsafe();
      if (listCalls >= failListFromCall) {
        return Effect.fail(new ProjectMemoryStoreError({ message: "The memory store failed." }));
      }
      if (heldProject !== null && input.projectId === heldProject) {
        return Effect.andThen(releaseHeld.await, listResult(input.projectId));
      }
      return listResult(input.projectId);
    },
    [WS_METHODS.projectMemorySearch]: (input: { projectId: ProjectIdType }) =>
      listResult(input.projectId),
    [WS_METHODS.projectMemoryGet]: (input: { projectId: ProjectIdType; memoryId: string }) => {
      const memory = storeFor(input.projectId).get(input.memoryId);
      return memory === undefined
        ? Effect.fail(
            new ProjectMemoryNotFoundError({
              projectId: input.projectId,
              memoryId: input.memoryId as ProjectMemoryId,
            }),
          )
        : Effect.succeed({ memory: { ...summary(input.projectId, input.memoryId), body: "b" } });
    },
    [WS_METHODS.projectMemoryCreate]: (input: { projectId: ProjectIdType; title: string }) => {
      const store = storeFor(input.projectId);
      const memoryId = `memory-${store.size + 1}`;
      store.set(memoryId, { title: input.title, version: 1 });
      return Effect.succeed({
        memory: { ...summary(input.projectId, memoryId), body: "b" },
      });
    },
    [WS_METHODS.projectMemoryUpdate]: (input: {
      projectId: ProjectIdType;
      memoryId: string;
      title?: string;
    }) => {
      const memory = storeFor(input.projectId).get(input.memoryId);
      if (memory === undefined) {
        return Effect.fail(
          new ProjectMemoryNotFoundError({
            projectId: input.projectId,
            memoryId: input.memoryId as ProjectMemoryId,
          }),
        );
      }
      memory.version += 1;
      if (input.title !== undefined) memory.title = input.title;
      return Effect.succeed({
        memory: { ...summary(input.projectId, input.memoryId), body: "b" },
      });
    },
    [WS_METHODS.projectMemoryDelete]: (input: { projectId: ProjectIdType; memoryId: string }) => {
      storeFor(input.projectId).delete(input.memoryId);
      return Effect.void;
    },
    [WS_METHODS.projectMemoryThreadState]: (input: {
      projectId: ProjectIdType;
      threadId: string;
      limit?: number;
    }) => {
      threadStateCalls += 1;
      const key = JSON.stringify(input);
      threadStateCallsByKey.set(key, (threadStateCallsByKey.get(key) ?? 0) + 1);
      if (threadStateCalls >= threadStateRefetchThreshold) threadStateRefetchLatch.openUnsafe();
      if (threadStateCalls >= failThreadStateFromCall) {
        return Effect.fail(new ProjectMemoryStoreError({ message: "The memory store failed." }));
      }
      if (heldThreadStateProject !== null && input.projectId === heldThreadStateProject) {
        return Effect.andThen(releaseHeldThreadState.await, threadStateResult(input));
      }
      return threadStateResult(input);
    },
    [WS_METHODS.projectMemoryAcknowledgeThread]: (input: {
      projectId: ProjectIdType;
      threadId: string;
      throughChangeSeq: number;
    }) => {
      ackInputs.push({ ...input });
      const key = threadKey(input.projectId, input.threadId);
      const acknowledgedThrough = threadStates.get(key)?.acknowledgedThrough ?? 0;
      if (acknowledgedThrough >= input.throughChangeSeq) {
        return Effect.succeed({ status: "unchanged" as const, acknowledgedThrough });
      }
      threadStates.set(key, {
        held: false,
        latestChangeSeq: threadStates.get(key)?.latestChangeSeq ?? input.throughChangeSeq,
        acknowledgedThrough: input.throughChangeSeq,
        changes: [],
        mayHaveMore: false,
      });
      return Effect.succeed({
        status: "applied" as const,
        acknowledgedThrough: input.throughChangeSeq,
      });
    },
  } as unknown as WsRpcProtocolClient;

  return {
    client,
    seed: (projectId: string, memoryId: string, title: string) => {
      storeFor(ProjectId.make(projectId)).set(memoryId, { title, version: 1 });
    },
    get listCalls() {
      return listCalls;
    },
    get listRefetched() {
      return refetchLatch;
    },
    get releaseHeld() {
      return releaseHeld;
    },
    get firstListStarted() {
      return firstListStarted;
    },
    armListRefetch: (callCount: number) => {
      refetchThreshold = callCount;
      refetchLatch = Latch.makeUnsafe();
    },
    armListFailure: (fromCall: number) => {
      failListFromCall = fromCall;
    },
    holdListsFor: (projectId: ProjectIdType) => {
      heldProject = projectId;
    },
    setThreadState: (projectId: string, threadId: string, state: ProjectMemoryThreadState) => {
      threadStates.set(threadKey(ProjectId.make(projectId), threadId), state);
    },
    get threadStateCalls() {
      return threadStateCalls;
    },
    threadStateCallsFor: (input: { projectId: string; threadId: string; limit?: number }) =>
      threadStateCallsByKey.get(JSON.stringify(input)) ?? 0,
    armThreadStateRefetch: (callCount: number) => {
      threadStateRefetchThreshold = callCount;
      threadStateRefetchLatch = Latch.makeUnsafe();
    },
    get threadStateRefetched() {
      return threadStateRefetchLatch;
    },
    armThreadStateFailure: (fromCall: number) => {
      failThreadStateFromCall = fromCall;
    },
    holdThreadStateFor: (projectId: ProjectIdType) => {
      heldThreadStateProject = projectId;
    },
    get releaseHeldThreadState() {
      return releaseHeldThreadState;
    },
    get ackInputs() {
      return ackInputs;
    },
  };
}

const makeHarness = Effect.fn("TestProjectMemory.makeHarness")(function* () {
  const memoryClient = makeMemoryClient();
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: ENVIRONMENT,
    state: yield* SubscriptionRef.make(connectionState()),
    session: yield* SubscriptionRef.make(Option.some(makeSession(memoryClient.client))),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_environmentId, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    _environmentId,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
  );
  const atoms = createProjectMemoryAtoms(runtime);
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
    Effect.sync(() => registry.dispose()),
  );
  return { atoms, registry, memoryClient };
});

const scope = (projectId: string) => ({
  environmentId: ENVIRONMENT_ID,
  input: { projectId: ProjectId.make(projectId) },
});

// One builder for every thread-state target and call-count lookup so the mock's
// JSON keys and the atoms' keys are built from identically ordered literals.
const threadScope = (projectId: string, threadId: string, limit?: number) => ({
  environmentId: ENVIRONMENT_ID,
  input:
    limit === undefined
      ? { projectId: ProjectId.make(projectId), threadId: ThreadId.make(threadId) }
      : { projectId: ProjectId.make(projectId), threadId: ThreadId.make(threadId), limit },
});

const HELD_THREAD_STATE: ProjectMemoryThreadState = {
  held: true,
  latestChangeSeq: 2,
  acknowledgedThrough: 0,
  changes: [
    { changeSeq: 2, reason: "updated", memoryId: "memory-1" as ProjectMemoryId },
    { changeSeq: 1, reason: "deleted" },
  ],
  mayHaveMore: false,
};

describe("project memory state", () => {
  it.effect("a create refreshes the same project's mounted list with the new memory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        const listAtom = atoms.list(scope("project-1"));
        const mounted = registry.mount(listAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        const initial = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(initial.items).toEqual([]);
        memoryClient.armListRefetch(2);

        const created = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.create, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              kind: "fact",
              title: "Deploys on Tue",
              body: "Release happens on Tuesdays.",
            },
          }),
        );
        expect(created._tag).toBe("Success");
        yield* memoryClient.listRefetched.await;

        expect(memoryClient.listCalls).toBe(2);
        const refreshed = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(refreshed.items.map((item) => item.title)).toEqual(["Deploys on Tue"]);
      }),
    ),
  );

  it.effect("a write on one project never refetches another project's reads", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        const otherList = atoms.list(scope("project-2"));
        const mounted = registry.mount(otherList);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        yield* AtomRegistry.getResult(registry, otherList, { suspendOnWaiting: true });

        const result = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.create, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              kind: "fact",
              title: "Only here",
              body: "b",
            },
          }),
        );
        expect(result._tag).toBe("Success");

        expect(memoryClient.listCalls).toBe(1);
      }),
    ),
  );

  it.effect("a delete refreshes the list and the deleted memory's detail", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.seed("project-1", "memory-1", "Doomed");
        const listAtom = atoms.list(scope("project-1"));
        const getAtom = atoms.get({
          environmentId: ENVIRONMENT_ID,
          input: {
            projectId: ProjectId.make("project-1"),
            memoryId: "memory-1" as ProjectMemoryId,
          },
        });
        const mounted = registry.mount(getAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );

        const before = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        yield* AtomRegistry.getResult(registry, getAtom, { suspendOnWaiting: true });
        expect(before.items.map((item) => item.title)).toEqual(["Doomed"]);
        memoryClient.armListRefetch(2);

        const deleted = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.delete, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              memoryId: "memory-1" as ProjectMemoryId,
              expectedVersion: 1,
            },
          }),
        );
        expect(deleted._tag).toBe("Success");
        yield* memoryClient.listRefetched.await;

        const after = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(after.items).toEqual([]);
        // One list refetch plus one detail refetch for the still-mounted get.
        expect(memoryClient.listCalls).toBe(2);
      }),
    ),
  );

  it.effect("a failed refetch after delete surfaces an error without the deleted list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.seed("project-1", "memory-1", "Doomed");
        const listAtom = atoms.list(scope("project-1"));
        const failed = Latch.makeUnsafe();
        const unsubscribe = registry.subscribe(
          listAtom,
          (result) => {
            if (result._tag === "Failure") failed.openUnsafe();
          },
          { immediate: false },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
          }),
        );
        const before = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(before.items.map((item) => item.title)).toEqual(["Doomed"]);
        memoryClient.armListRefetch(2);
        memoryClient.armListFailure(2);

        const deleted = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.delete, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              memoryId: "memory-1" as ProjectMemoryId,
              expectedVersion: 1,
            },
          }),
        );
        expect(deleted._tag).toBe("Success");
        yield* failed.await;

        // The wrapper forwards the failure without its previousSuccess, so no
        // consumer can read the deleted list back out of the error state.
        const raw = registry.get(listAtom) as AsyncResult.AsyncResult<
          { items: ReadonlyArray<ProjectMemorySummary> },
          unknown
        >;
        expect(raw._tag).toBe("Failure");
        expect(Option.isNone(AsyncResult.value(raw))).toBe(true);
      }),
    ),
  );

  it.effect("a delayed refetch after delete reports waiting with no stale value", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.seed("project-1", "memory-1", "Doomed");
        const listAtom = atoms.list(scope("project-1"));
        const mounted = registry.mount(listAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        const before = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(before.items.map((item) => item.title)).toEqual(["Doomed"]);
        memoryClient.armListRefetch(2);
        memoryClient.holdListsFor(ProjectId.make("project-1"));

        const deleted = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.delete, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              memoryId: "memory-1" as ProjectMemoryId,
              expectedVersion: 1,
            },
          }),
        );
        expect(deleted._tag).toBe("Success");
        yield* memoryClient.listRefetched.await;

        // The post-write refetch is still in flight: the wrapper reports
        // waiting and exposes no value, so the deleted memory cannot linger.
        const pending = registry.get(listAtom) as AsyncResult.AsyncResult<
          { items: ReadonlyArray<ProjectMemorySummary> },
          unknown
        >;
        expect(pending.waiting).toBe(true);
        expect(Option.isNone(AsyncResult.value(pending))).toBe(true);

        memoryClient.releaseHeld.openUnsafe();
        const after = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(after.items).toEqual([]);
      }),
    ),
  );

  it.effect("a same-key response in flight before a delete never reaches the reader", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.seed("project-1", "memory-1", "Doomed");
        memoryClient.holdListsFor(ProjectId.make("project-1"));
        const listAtom = atoms.list(scope("project-1"));
        const observed: Array<ReadonlyArray<string>> = [];
        const unsubscribe = registry.subscribe(
          listAtom,
          (result) => {
            const value = Option.getOrNull(AsyncResult.value(result));
            if (value !== null) observed.push(value.items.map((item) => item.title));
          },
          { immediate: true },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
          }),
        );
        // Prove the pre-delete request actually started (and is held) before
        // writing; otherwise the delete's refetch ordering below is untested.
        yield* memoryClient.firstListStarted.await;
        memoryClient.armListRefetch(2);

        const deleted = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.delete, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              memoryId: "memory-1" as ProjectMemoryId,
              expectedVersion: 1,
            },
          }),
        );
        expect(deleted._tag).toBe("Success");
        yield* memoryClient.listRefetched.await;
        memoryClient.releaseHeld.openUnsafe();
        const after = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });

        expect(after.items).toEqual([]);
        // The pre-delete response was interrupted by the post-write refresh;
        // nothing the reader saw ever contained the deleted title.
        expect(observed.some((items) => items.includes("Doomed"))).toBe(false);
      }),
    ),
  );

  it.effect("repeated reads of one scope reuse one stable wrapper atom", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        // The same target must resolve to one wrapper atom instance, so React
        // re-renders cannot resubscribe to a fresh identity; a different
        // target stays its own atom.
        const first = atoms.list(scope("project-1"));
        expect(atoms.list(scope("project-1"))).toBe(first);
        expect(atoms.list(scope("project-2"))).not.toBe(first);

        const mounted = registry.mount(first);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        yield* AtomRegistry.getResult(registry, first, { suspendOnWaiting: true });
        yield* AtomRegistry.getResult(registry, first, { suspendOnWaiting: true });
        // The repeated read is served by the cached query, not a second load.
        expect(memoryClient.listCalls).toBe(1);
      }),
    ),
  );

  it.effect("a late list response fills only its own project's atom", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.seed("project-1", "a-1", "From project one");
        memoryClient.seed("project-2", "b-1", "From project two");
        memoryClient.holdListsFor(ProjectId.make("project-1"));
        const listA = atoms.list(scope("project-1"));
        const listB = atoms.list(scope("project-2"));
        const mountedA = registry.mount(listA);
        const mountedB = registry.mount(listB);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mountedA();
            mountedB();
          }),
        );

        const b = yield* AtomRegistry.getResult(registry, listB, { suspendOnWaiting: true });
        expect(b.items.map((item) => item.title)).toEqual(["From project two"]);
        memoryClient.releaseHeld.openUnsafe();
        const a = yield* AtomRegistry.getResult(registry, listA, { suspendOnWaiting: true });
        expect(a.items.map((item) => item.title)).toEqual(["From project one"]);
      }),
    ),
  );

  it.effect("an explicit refresh of the read forwards to the query", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.seed("project-1", "memory-1", "Doomed");
        const listAtom = atoms.list(scope("project-1"));
        const mounted = registry.mount(listAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        const before = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(before.items.map((item) => item.title)).toEqual(["Doomed"]);
        memoryClient.seed("project-1", "memory-2", "Fresh");
        memoryClient.armListRefetch(2);

        // Without the wrapper's forwarding refresh, an explicit refresh of the
        // read would never reach the wire and the cached value would stick.
        registry.refresh(listAtom);
        yield* memoryClient.listRefetched.await;
        expect(memoryClient.listCalls).toBe(2);
        const after = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        expect(after.items.map((item) => item.title)).toEqual(["Doomed", "Fresh"]);
      }),
    ),
  );

  it.effect("list and search are distinct atoms for the same project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry } = yield* makeHarness();
        const listAtom = atoms.list({
          environmentId: ENVIRONMENT_ID,
          input: { projectId: ProjectId.make("project-1") },
        });
        const searchAtom = atoms.search({
          environmentId: ENVIRONMENT_ID,
          input: { projectId: ProjectId.make("project-1"), query: "deploy" },
        });

        const listed = yield* AtomRegistry.getResult(registry, listAtom, {
          suspendOnWaiting: true,
        });
        const searched = yield* AtomRegistry.getResult(registry, searchAtom, {
          suspendOnWaiting: true,
        });

        expect(listed.truncated).toBe(false);
        expect(searched.truncated).toBe(false);
        expect(listAtom).not.toBe(searchAtom);
      }),
    ),
  );

  it.effect("an acknowledge refreshes every mounted limit variant with the post-ack state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.setThreadState("project-1", "thread-1", HELD_THREAD_STATE);
        const defaultVariant = atoms.threadState(threadScope("project-1", "thread-1"));
        const pageVariant = atoms.threadState(threadScope("project-1", "thread-1", 5));
        const mountedDefault = registry.mount(defaultVariant);
        const mountedPage = registry.mount(pageVariant);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mountedDefault();
            mountedPage();
          }),
        );
        const firstDefault = yield* AtomRegistry.getResult(registry, defaultVariant, {
          suspendOnWaiting: true,
        });
        const firstPage = yield* AtomRegistry.getResult(registry, pageVariant, {
          suspendOnWaiting: true,
        });
        expect(firstDefault.held).toBe(true);
        expect(firstPage.held).toBe(true);
        // Both variants must refetch before the latch opens: one refresh per
        // mounted variant, not a single shared one.
        memoryClient.armThreadStateRefetch(4);

        const acked = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.acknowledgeThread, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
              throughChangeSeq: 2,
            },
          }),
        );
        expect(acked._tag).toBe("Success");
        yield* memoryClient.threadStateRefetched.await;

        expect(
          memoryClient.threadStateCallsFor({ projectId: "project-1", threadId: "thread-1" }),
        ).toBe(2);
        expect(
          memoryClient.threadStateCallsFor({
            projectId: "project-1",
            threadId: "thread-1",
            limit: 5,
          }),
        ).toBe(2);
        const secondDefault = yield* AtomRegistry.getResult(registry, defaultVariant, {
          suspendOnWaiting: true,
        });
        const secondPage = yield* AtomRegistry.getResult(registry, pageVariant, {
          suspendOnWaiting: true,
        });
        expect(secondDefault.held).toBe(false);
        expect(secondDefault.acknowledgedThrough).toBe(2);
        expect(secondDefault.changes).toEqual([]);
        expect(secondPage.acknowledgedThrough).toBe(2);
        expect(secondPage.changes).toEqual([]);
      }),
    ),
  );

  it.effect("a failed thread-state refetch after acknowledge surfaces no prior value", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.setThreadState("project-1", "thread-1", HELD_THREAD_STATE);
        const threadStateAtom = atoms.threadState(threadScope("project-1", "thread-1"));
        const failed = Latch.makeUnsafe();
        const unsubscribe = registry.subscribe(
          threadStateAtom,
          (result) => {
            if (result._tag === "Failure") failed.openUnsafe();
          },
          { immediate: false },
        );
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            unsubscribe();
          }),
        );
        const mounted = registry.mount(threadStateAtom);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mounted();
          }),
        );
        const before = yield* AtomRegistry.getResult(registry, threadStateAtom, {
          suspendOnWaiting: true,
        });
        expect(before.held).toBe(true);
        memoryClient.armThreadStateRefetch(2);
        memoryClient.armThreadStateFailure(2);

        const acked = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.acknowledgeThread, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
              throughChangeSeq: 2,
            },
          }),
        );
        expect(acked._tag).toBe("Success");
        yield* failed.await;

        // The wrapper forwards the refetch failure without its previousSuccess,
        // so the pre-ack history cannot be read back out of the error state.
        const raw = registry.get(threadStateAtom) as AsyncResult.AsyncResult<
          ProjectMemoryThreadState,
          unknown
        >;
        expect(raw._tag).toBe("Failure");
        expect(Option.isNone(AsyncResult.value(raw))).toBe(true);
      }),
    ),
  );

  it.effect(
    "a delayed thread-state refetch after acknowledge reports waiting with no stale value",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { atoms, registry, memoryClient } = yield* makeHarness();
          memoryClient.setThreadState("project-1", "thread-1", HELD_THREAD_STATE);
          const threadStateAtom = atoms.threadState(threadScope("project-1", "thread-1"));
          const mounted = registry.mount(threadStateAtom);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              mounted();
            }),
          );
          const before = yield* AtomRegistry.getResult(registry, threadStateAtom, {
            suspendOnWaiting: true,
          });
          expect(before.held).toBe(true);
          memoryClient.armThreadStateRefetch(2);
          memoryClient.holdThreadStateFor(ProjectId.make("project-1"));

          const acked = yield* Effect.promise(() =>
            runAtomCommand(registry, atoms.acknowledgeThread, {
              environmentId: ENVIRONMENT_ID,
              input: {
                projectId: ProjectId.make("project-1"),
                threadId: ThreadId.make("thread-1"),
                throughChangeSeq: 2,
              },
            }),
          );
          expect(acked._tag).toBe("Success");
          yield* memoryClient.threadStateRefetched.await;

          // The post-ack refetch is still in flight: the wrapper reports waiting
          // and exposes no value, so the unacknowledged history cannot linger.
          const pending = registry.get(threadStateAtom) as AsyncResult.AsyncResult<
            ProjectMemoryThreadState,
            unknown
          >;
          expect(pending.waiting).toBe(true);
          expect(Option.isNone(AsyncResult.value(pending))).toBe(true);

          memoryClient.releaseHeldThreadState.openUnsafe();
          const after = yield* AtomRegistry.getResult(registry, threadStateAtom, {
            suspendOnWaiting: true,
          });
          expect(after.held).toBe(false);
          expect(after.acknowledgedThrough).toBe(2);
        }),
      ),
  );

  it.effect("an acknowledge passes the caller's watermark through unchanged", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        // Latest seq is 9 on the wire; the caller acknowledges the shown
        // watermark 4. A client that silently advanced to the latest seq
        // would put 9 on the wire instead.
        memoryClient.setThreadState("project-1", "thread-1", {
          held: true,
          latestChangeSeq: 9,
          acknowledgedThrough: 0,
          changes: [{ changeSeq: 9, reason: "updated", memoryId: "memory-1" as ProjectMemoryId }],
          mayHaveMore: true,
        });

        const firstAck = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.acknowledgeThread, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
              throughChangeSeq: 4,
            },
          }),
        );
        expect(firstAck._tag).toBe("Success");
        if (firstAck._tag === "Success") {
          expect(firstAck.value).toEqual({ status: "applied", acknowledgedThrough: 4 });
        }

        // Retrying the same watermark settles as unchanged at the same value.
        const retryAck = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.acknowledgeThread, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
              throughChangeSeq: 4,
            },
          }),
        );
        expect(retryAck._tag).toBe("Success");
        if (retryAck._tag === "Success") {
          expect(retryAck.value).toEqual({ status: "unchanged", acknowledgedThrough: 4 });
        }

        expect(memoryClient.ackInputs).toEqual([
          { projectId: "project-1", threadId: "thread-1", throughChangeSeq: 4 },
          { projectId: "project-1", threadId: "thread-1", throughChangeSeq: 4 },
        ]);
        // The ack command itself performs no state read; only a mounted
        // variant's signal-driven refresh does.
        expect(memoryClient.threadStateCalls).toBe(0);
      }),
    ),
  );

  it.effect("an acknowledge never refetches another environment's or project's thread state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { atoms, registry, memoryClient } = yield* makeHarness();
        memoryClient.setThreadState("project-1", "thread-1", HELD_THREAD_STATE);
        memoryClient.setThreadState("project-2", "thread-1", HELD_THREAD_STATE);
        const otherEnvironment = EnvironmentId.make("other-environment");
        const otherEnvSameProject = atoms.threadState({
          environmentId: otherEnvironment,
          input: { projectId: ProjectId.make("project-1"), threadId: ThreadId.make("thread-1") },
        });
        const otherEnvOtherProject = atoms.threadState({
          environmentId: otherEnvironment,
          input: { projectId: ProjectId.make("project-2"), threadId: ThreadId.make("thread-1") },
        });
        const mountedSame = registry.mount(otherEnvSameProject);
        const mountedOther = registry.mount(otherEnvOtherProject);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            mountedSame();
            mountedOther();
          }),
        );
        const sameBefore = yield* AtomRegistry.getResult(registry, otherEnvSameProject, {
          suspendOnWaiting: true,
        });
        const otherBefore = yield* AtomRegistry.getResult(registry, otherEnvOtherProject, {
          suspendOnWaiting: true,
        });
        expect(sameBefore.held).toBe(true);
        expect(otherBefore.held).toBe(true);
        expect(memoryClient.threadStateCalls).toBe(2);

        const acked = yield* Effect.promise(() =>
          runAtomCommand(registry, atoms.acknowledgeThread, {
            environmentId: ENVIRONMENT_ID,
            input: {
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
              throughChangeSeq: 2,
            },
          }),
        );
        expect(acked._tag).toBe("Success");

        // Neither the same project in another environment nor another project
        // in that environment moved: no extra RPC and no changed values.
        expect(memoryClient.threadStateCalls).toBe(2);
        const sameAfter = yield* AtomRegistry.getResult(registry, otherEnvSameProject, {
          suspendOnWaiting: true,
        });
        const otherAfter = yield* AtomRegistry.getResult(registry, otherEnvOtherProject, {
          suspendOnWaiting: true,
        });
        expect(sameAfter.held).toBe(true);
        expect(sameAfter.acknowledgedThrough).toBe(0);
        expect(otherAfter.acknowledgedThrough).toBe(0);
      }),
    ),
  );
});
