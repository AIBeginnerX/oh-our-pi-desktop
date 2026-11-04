import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** Runs a crew task that ended without finishing again, as a new task on the same lead thread. */
export const crewRetryTask = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:crew:retry-task",
  tag: WS_METHODS.crewRetryTask,
});

/** Stops one running crew task of a lead thread, or all of them when no task id is given. */
export const crewStopTasks = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:crew:stop-tasks",
  tag: WS_METHODS.crewStopTasks,
});
