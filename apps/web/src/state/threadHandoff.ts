import { ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** The server-built note a continuation thread starts from. */
export const threadHandoffSeed = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration:thread-handoff-seed",
  tag: ORCHESTRATION_WS_METHODS.getThreadHandoffSeed,
});
