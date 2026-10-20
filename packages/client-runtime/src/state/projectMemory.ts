import { type EnvironmentId, type ProjectId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

interface ProjectMemoryScope {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly projectId: ProjectId };
}

/** JSON tuple key, so one environment or project id can never collide with another scope. */
function projectMemoryScopeKey(scope: ProjectMemoryScope): string {
  return JSON.stringify([scope.environmentId, scope.input.projectId]);
}

/**
 * A stateless read wrapper over one of the query atoms.
 *
 * Every pending read — first load, post-write refetch, background
 * revalidation — reports waiting with no value, so a memory the write replaced
 * or deleted can never flash back through a pending window. A refetch failure
 * is forwarded without its previousSuccess, so `AsyncResult.value` stays empty
 * after a failed refresh too. The custom refresh callback forwards an explicit
 * refresh of this atom to the query itself; the change signal stays owned by
 * the query family's refresh-on-signal wiring.
 */
function projectMemoryRead<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  label: string,
): Atom.Atom<AsyncResult.AsyncResult<A, E>> {
  return Atom.readable(
    (get) => {
      const result = get(atom);
      if (result.waiting) return AsyncResult.initial<A, E>(true);
      if (result._tag === "Failure") {
        // A failed refetch must not hand the pre-write value back through
        // `AsyncResult.value` (a failure otherwise keeps its previousSuccess).
        return AsyncResult.failure<A, E>(result.cause);
      }
      return result;
    },
    (refresh) => refresh(atom),
  ).pipe(Atom.withLabel(label));
}

/**
 * Project-memory reads and writes for one environment.
 *
 * Memories are isolated per environment and project: every atom here is keyed
 * by both, so a pending fetch can never fill a view scoped to another project.
 * `staleTime` only decides whether a remount may reuse a cached result — it
 * never schedules a refresh — so changes made by other clients appear on the
 * next mount or triggered refresh, not on a timer.
 */
export function createProjectMemoryAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const writeScheduler = createAtomCommandScheduler();
  // Serial per environment+project so two racing writes cannot interleave with
  // the read refreshes their own successes trigger.
  const writeConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: { projectId: ProjectId };
    }) => JSON.stringify([environmentId, input.projectId]),
  };

  // Bumped by every successful create/update/delete. The queries refresh on
  // the bump (refresh-on-signal), and the read wrappers keep every pending
  // window valueless.
  const changeSignalFamily = Atom.family((key: string) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:project-memory:change:${key}`)),
  );
  const changeSignal = (scope: ProjectMemoryScope) =>
    changeSignalFamily(projectMemoryScopeKey(scope));
  const refreshOnWrite = (target: ProjectMemoryScope) => changeSignal(target);
  const bumpChangeSignal = (scope: ProjectMemoryScope, registry: AtomRegistry.AtomRegistry) => {
    const signal = changeSignal(scope);
    registry.set(signal, registry.get(signal) + 1);
  };

  const listFamily = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-memory:list",
    tag: WS_METHODS.projectMemoryList,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
    refreshTrigger: refreshOnWrite,
  });
  const searchFamily = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-memory:search",
    tag: WS_METHODS.projectMemorySearch,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
    refreshTrigger: refreshOnWrite,
  });
  // Detail feeds optimistic-concurrency edits: writes stay disabled until this
  // query resolves for the exact current memory, and a Conflict still tells
  // the editor when a version slipped through anyway.
  const getFamily = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-memory:get",
    tag: WS_METHODS.projectMemoryGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: refreshOnWrite,
  });
  // Thread recovery: one thread's retained change history, cached per
  // [environmentId, {projectId, threadId, limit}] so each mounted limit
  // variant tracks its own page. Every variant of a project refreshes from
  // that project's change signal — there is no push, so changes made by other
  // clients surface on this triggered refresh or on remount, never on a timer.
  const threadStateFamily = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-memory:thread-state",
    tag: WS_METHODS.projectMemoryThreadState,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: refreshOnWrite,
  });

  // One cached wrapper per underlying query atom, keyed exactly like the
  // family keys its queries (a JSON [environmentId, input] tuple). Without the
  // cache, every call allocated a new wrapper atom, so React re-renders would
  // see new atom identities and resubscribe/refetch the same query.
  const cachedRead = <I, A, E>(
    tag: string,
    family: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: I;
    }) => Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  ) => {
    const reads = Atom.family((key: string) => {
      const [environmentId, input] = JSON.parse(key) as [EnvironmentId, I];
      return projectMemoryRead(family({ environmentId, input }), `${tag}:${key}`);
    });
    return (target: { readonly environmentId: EnvironmentId; readonly input: I }) =>
      reads(JSON.stringify([target.environmentId, target.input]));
  };

  return {
    list: cachedRead("environment-data:project-memory:list", listFamily),
    search: cachedRead("environment-data:project-memory:search", searchFamily),
    get: cachedRead("environment-data:project-memory:get", getFamily),
    threadState: cachedRead("environment-data:project-memory:thread-state", threadStateFamily),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-memory:create",
      tag: WS_METHODS.projectMemoryCreate,
      scheduler: writeScheduler,
      concurrency: writeConcurrency,
      onSuccess: ({ environmentId, input: { projectId } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, input: { projectId } }, registry)),
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-memory:update",
      tag: WS_METHODS.projectMemoryUpdate,
      scheduler: writeScheduler,
      concurrency: writeConcurrency,
      onSuccess: ({ environmentId, input: { projectId } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, input: { projectId } }, registry)),
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-memory:delete",
      tag: WS_METHODS.projectMemoryDelete,
      scheduler: writeScheduler,
      concurrency: writeConcurrency,
      onSuccess: ({ environmentId, input: { projectId } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, input: { projectId } }, registry)),
    }),
    // Passes the caller's watermark to the server untouched — acknowledging
    // every retained change through it — then bumps the project change signal
    // so mounted thread-state variants refetch.
    acknowledgeThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-memory:acknowledge-thread",
      tag: WS_METHODS.projectMemoryAcknowledgeThread,
      scheduler: writeScheduler,
      concurrency: writeConcurrency,
      onSuccess: ({ environmentId, input: { projectId } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, input: { projectId } }, registry)),
    }),
    // Forces the scope's reads to refetch (list, search and detail) — used
    // after a Conflict so review never re-seeds from a stale response.
    revalidate: createEnvironmentCommand(runtime, {
      label: "environment-data:project-memory:revalidate",
      execute: (input: { projectId: ProjectId }, registry, environmentId) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, input }, registry)),
    }),
  };
}
