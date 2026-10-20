import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { Atom } from "effect/unstable/reactivity";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/** All requests route to the environment that owns the thread. */
export function createReleaseVerificationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const runConcurrency = {
    mode: "singleFlight" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: string;
      readonly input: { readonly threadId: string };
    }) => `${environmentId}:${input.threadId}`,
  };
  const cancelConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const get = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:release-verification:get",
    tag: WS_METHODS.releaseVerificationGet,
    staleTimeMs: 0,
  });
  const run = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:release-verification:run",
    tag: WS_METHODS.releaseVerificationRun,
    scheduler,
    concurrency: runConcurrency,
  });
  const cancel = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:release-verification:cancel",
    tag: WS_METHODS.releaseVerificationCancel,
    scheduler,
    concurrency: cancelConcurrency,
  });
  return { get, run, cancel };
}
