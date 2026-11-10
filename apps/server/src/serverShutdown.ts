/**
 * Process-wide server shutdown marker.
 *
 * The server is its own process-group leader, so a shutdown SIGTERM/SIGINT
 * reaches its provider CLI children at the same moment it reaches the server.
 * Adapters consult `isServerShuttingDown` to leave still-running sessions for
 * `ProviderService.runStopAll` — which records their continuation and stops
 * them — instead of failing their turns with the provider's death.
 *
 * The signal listeners are installed scoped by the server runtime layer in
 * `server.ts`, so they exist exactly while the server runs.
 */

let shuttingDown = false;

export const isServerShuttingDown = (): boolean => shuttingDown;

export const installServerShutdownSignalListeners = (): (() => void) => {
  const onSignal = (): void => {
    shuttingDown = true;
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
};
