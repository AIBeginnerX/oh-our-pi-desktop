import { type EnvironmentId, type ProjectId, type ThreadId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

interface ProjectSkillScope {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

/** JSON tuple key, so one environment or project id can never collide with another scope. */
function projectSkillScopeKey(scope: ProjectSkillScope): string {
  return JSON.stringify([scope.environmentId, scope.projectId]);
}

/**
 * A stateless read wrapper over one of the query atoms.
 *
 * Every pending read — first load, post-write refetch, explicit
 * revalidation — reports waiting with no value, so a version the write
 * replaced or deleted can never flash back through a pending window. A
 * refetch failure is forwarded without its previousSuccess, so
 * `AsyncResult.value` stays empty after a failed refresh too. The custom
 * refresh callback forwards an explicit refresh of this atom to the query
 * itself; the change signal stays owned by the query family's
 * refresh-on-signal wiring.
 */
function projectSkillRead<A, E>(
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
 * Inactive project-skill candidate reads and writes for one environment.
 *
 * Skills are isolated per environment and project: every atom here is keyed
 * by both, so a pending fetch can never fill a view scoped to another
 * project. Query and wrapper identity use the full `[environmentId, input]`
 * key — `get` stays distinct per skillId and `list` per limit — while the
 * write lane and change signal key only `[environmentId, projectId]`, so one
 * write refreshes every mounted variant of that project. `staleTime` only
 * decides whether a remount may reuse a cached result — it never schedules a
 * refresh — so changes made by other clients appear on the next mount or
 * triggered refresh, not on a timer.
 */
export function createProjectSkillAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const writeScheduler = createAtomCommandScheduler();
  const deriveScheduler = createAtomCommandScheduler();
  // One serial lane per environment+project shared by all writes, so a
  // revise and a delete (or a judgment pair) can never overlap at the wire.
  // The lane covers each command's RPC plus the synchronous invalidation bump
  // in onSuccess only — it does not await the read refreshes that bump
  // triggers. recordJudgment and withdrawJudgment carry no top-level
  // projectId — they take it from `input.ref.projectId`, the same scope the
  // version belongs to.
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
  const writeConcurrencyByRef = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: EnvironmentId;
      input: { ref: { projectId: ProjectId } };
    }) => JSON.stringify([environmentId, input.ref.projectId]),
  };

  // Bumped by every successful write. The queries refresh on the bump
  // (refresh-on-signal), and the read wrappers keep every pending window
  // valueless. onSuccess fires for any resolved RPC — including delete's
  // `{status:"conflict"}` and withdraw's `not-found`/`already-withdrawn` —
  // which is the correct conservative refresh; the status union is the
  // caller's answer about what applied, not proof a mutation landed.
  const changeSignalFamily = Atom.family((key: string) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:project-skill:change:${key}`)),
  );
  const changeSignal = (scope: ProjectSkillScope) =>
    changeSignalFamily(projectSkillScopeKey(scope));
  const refreshOnWrite = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly projectId: ProjectId };
  }) => changeSignal({ environmentId: target.environmentId, projectId: target.input.projectId });
  const bumpChangeSignal = (scope: ProjectSkillScope, registry: AtomRegistry.AtomRegistry) => {
    const signal = changeSignal(scope);
    registry.set(signal, registry.get(signal) + 1);
  };

  const listFamily = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-skill:list",
    tag: WS_METHODS.projectSkillList,
    staleTimeMs: 15_000,
    idleTtlMs: 60_000,
    refreshTrigger: refreshOnWrite,
  });
  // Detail feeds optimistic-concurrency revise/delete inputs: callers pin
  // `expectedLatestVersion` from the detail they last resolved, and a typed
  // Conflict still tells them when a version slipped through anyway.
  const getFamily = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:project-skill:get",
    tag: WS_METHODS.projectSkillGet,
    staleTimeMs: 5_000,
    idleTtlMs: 60_000,
    refreshTrigger: refreshOnWrite,
  });

  // One cached wrapper per underlying query atom, keyed exactly like the
  // family keys its queries (a JSON [environmentId, input] tuple). Without
  // the cache, every call allocated a new wrapper atom, so consumers would
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
      return projectSkillRead(family({ environmentId, input }), `${tag}:${key}`);
    });
    return (target: { readonly environmentId: EnvironmentId; readonly input: I }) =>
      reads(JSON.stringify([target.environmentId, target.input]));
  };

  return {
    list: cachedRead("environment-data:project-skill:list", listFamily),
    get: cachedRead("environment-data:project-skill:get", getFamily),
    deriveDraft: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:derive-draft",
      tag: WS_METHODS.projectSkillDeriveDraft,
      scheduler: deriveScheduler,
      concurrency: {
        mode: "latest" as const,
        key: ({
          environmentId,
          input,
        }: {
          environmentId: EnvironmentId;
          input: { projectId: ProjectId; threadId: ThreadId };
        }) => JSON.stringify([environmentId, input.projectId, input.threadId]),
      },
    }),
    createCandidate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:create-candidate",
      tag: WS_METHODS.projectSkillCreateCandidate,
      scheduler: writeScheduler,
      concurrency: writeConcurrency,
      onSuccess: ({ environmentId, input: { projectId } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, projectId }, registry)),
    }),
    revise: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:revise",
      tag: WS_METHODS.projectSkillRevise,
      scheduler: writeScheduler,
      concurrency: writeConcurrency,
      onSuccess: ({ environmentId, input: { projectId } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, projectId }, registry)),
    }),
    recordJudgment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:record-judgment",
      tag: WS_METHODS.projectSkillRecordJudgment,
      scheduler: writeScheduler,
      concurrency: writeConcurrencyByRef,
      onSuccess: ({ environmentId, input: { ref } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, projectId: ref.projectId }, registry)),
    }),
    withdrawJudgment: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:withdraw-judgment",
      tag: WS_METHODS.projectSkillWithdrawJudgment,
      scheduler: writeScheduler,
      concurrency: writeConcurrencyByRef,
      onSuccess: ({ environmentId, input: { ref } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, projectId: ref.projectId }, registry)),
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:delete",
      tag: WS_METHODS.projectSkillDelete,
      scheduler: writeScheduler,
      concurrency: writeConcurrency,
      onSuccess: ({ environmentId, input: { projectId } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, projectId }, registry)),
    }),
    activate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:activate",
      tag: WS_METHODS.projectSkillActivate,
      scheduler: writeScheduler,
      concurrency: writeConcurrencyByRef,
      onSuccess: ({ environmentId, input: { ref } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, projectId: ref.projectId }, registry)),
    }),
    retire: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:project-skill:retire",
      tag: WS_METHODS.projectSkillRetire,
      scheduler: writeScheduler,
      concurrency: writeConcurrencyByRef,
      onSuccess: ({ environmentId, input: { ref } }, registry) =>
        Effect.sync(() => bumpChangeSignal({ environmentId, projectId: ref.projectId }, registry)),
    }),
    // Forces the scope's reads to refetch (list and detail) — used after a
    // typed revise Conflict so callers never re-seed an expected version from
    // a stale response.
    revalidate: createEnvironmentCommand(runtime, {
      label: "environment-data:project-skill:revalidate",
      execute: (input: { projectId: ProjectId }, registry, environmentId) =>
        Effect.sync(() =>
          bumpChangeSignal({ environmentId, projectId: input.projectId }, registry),
        ),
    }),
  };
}
