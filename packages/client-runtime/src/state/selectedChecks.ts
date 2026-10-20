import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/unstable/reactivity";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * Selected-checks requests route to the environment that owns the thread.
 * The get is a command, not a cached query atom: it only runs when the panel
 * asks for it, each invocation produces a promise the hook can tag with a
 * generation, and `latest` keeps at most one queued re-request per thread
 * (a superseded caller is not interrupted; stale generations just ignore the
 * shared result).
 */
export function createSelectedChecksEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const threadKey = ({
    environmentId,
    input,
  }: {
    readonly environmentId: string;
    readonly input: { readonly threadId: string };
  }) => `${environmentId}:${input.threadId}`;
  const getConcurrency = { mode: "latest" as const, key: threadKey };
  const runConcurrency = { mode: "singleFlight" as const, key: threadKey };
  const environmentConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const get = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:selected-checks:get",
    tag: WS_METHODS.selectedChecksGet,
    scheduler,
    concurrency: getConcurrency,
  });
  const run = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:selected-checks:run",
    tag: WS_METHODS.selectedChecksRun,
    scheduler,
    concurrency: runConcurrency,
  });
  const cancel = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:selected-checks:cancel",
    tag: WS_METHODS.selectedChecksCancel,
    scheduler,
    concurrency: environmentConcurrency,
  });
  const resolveOwnership = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:selected-checks:resolve-ownership",
    tag: WS_METHODS.selectedChecksResolveOwnership,
    scheduler,
    concurrency: environmentConcurrency,
  });
  return { get, run, cancel, resolveOwnership };
}
