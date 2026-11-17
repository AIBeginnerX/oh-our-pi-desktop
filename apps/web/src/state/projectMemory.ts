import { createProjectMemoryAtoms } from "@t3tools/client-runtime/state/project-memory";

import { type EnvironmentId, type ProjectId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Web instantiation of the shared project-memory atoms. */
const base = createProjectMemoryAtoms(connectionAtomRuntime);
type Scope = { environmentId: EnvironmentId; input: { projectId: ProjectId } };
const signalFamily = Atom.family((key: string) =>
  Atom.make(0).pipe(Atom.withLabel(`project-memory-tidy:${key}`)),
);
const signal = (scope: Scope) =>
  signalFamily(JSON.stringify([scope.environmentId, scope.input.projectId]));
const tidies = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "project-memory:tidies",
  tag: WS_METHODS.projectMemoryListTidy,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
  refreshTrigger: signal,
});
const refresh = (scope: Scope, registry: AtomRegistry.AtomRegistry) =>
  Effect.sync(() => {
    const changed = signal(scope);
    registry.set(changed, registry.get(changed) + 1);
  }).pipe(
    Effect.andThen(Effect.promise(() => base.revalidate.run(registry, scope))),
    Effect.asVoid,
  );
export const projectMemory = {
  ...base,
  tidies,
  applyTidy: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-memory:apply-tidy",
    tag: WS_METHODS.projectMemoryApplyTidy,
    onSuccess: refresh,
  }),
  dismissTidy: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-memory:dismiss-tidy",
    tag: WS_METHODS.projectMemoryDismissTidy,
    onSuccess: refresh,
  }),
  analyse: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "project-memory:analyse-with-tidy",
    tag: WS_METHODS.projectMemoryAnalyse,
    onSuccess: refresh,
  }),
};
