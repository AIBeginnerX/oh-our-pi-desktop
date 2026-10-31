import { watchSignals, type SignalSource } from "./signals.ts";

export interface GuardedProcess extends SignalSource {
  readonly once: (event: "exit", listener: () => void) => unknown;
  readonly exit: (code: number) => unknown;
}

/**
 * Keeps a screen that has put the terminal in raw mode from leaving it that way. A signal that
 * ends the process (SIGTERM, SIGHUP, ...) would otherwise kill it with bracketed paste still on, so
 * each becomes a normal exit, and the `exit` event undoes the mode. SIGCONT after Ctrl-Z puts the
 * mode back. Returns the function that stops guarding, for when the screen ends by itself.
 */
export const guardTerminal = (
  io: {
    readonly process: GuardedProcess;
    readonly write: (text: string) => unknown;
    readonly setRawMode: (raw: boolean) => unknown;
  },
  platform: NodeJS.Platform,
  modes: { readonly on: string; readonly off: string },
): (() => void) => {
  const leave = () => {
    io.write(modes.off);
    io.setRawMode(false);
  };
  io.process.once("exit", leave);
  const stopWatching = watchSignals(
    io.process,
    {
      exit: (code) => io.process.exit(code),
      resume: () => {
        io.setRawMode(true);
        io.write(modes.on);
      },
    },
    platform,
  );
  return () => {
    stopWatching();
    io.process.off("exit", leave);
  };
};
