/** Exit status of a process ended by a signal is 128 plus the signal number. */
const EXIT_CODES = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 } as const;

type Terminating = keyof typeof EXIT_CODES;

export interface SignalSource {
  readonly on: (signal: string, listener: () => void) => unknown;
  readonly off: (signal: string, listener: () => void) => unknown;
}

/** Windows has no SIGQUIT or SIGCONT; asking Node to watch them there is an error. */
export const signalsFor = (platform: NodeJS.Platform): ReadonlyArray<string> =>
  platform === "win32"
    ? ["SIGINT", "SIGTERM", "SIGHUP"]
    : ["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP", "SIGCONT"];

/**
 * Turns the signals that end the process into a normal exit (so the terminal is restored first) and
 * SIGCONT, which follows a Ctrl-Z, into a resume. Returns the function that stops watching.
 */
export const watchSignals = (
  source: SignalSource,
  handlers: { readonly exit: (code: number) => void; readonly resume: () => void },
  platform: NodeJS.Platform,
): (() => void) => {
  const registered = signalsFor(platform).map((signal) => {
    const listener =
      signal === "SIGCONT"
        ? handlers.resume
        : () => handlers.exit(EXIT_CODES[signal as Terminating]);
    source.on(signal, listener);
    return { signal, listener };
  });
  return () => {
    for (const { signal, listener } of registered) source.off(signal, listener);
  };
};

/** Calls `run` once, `delay` milliseconds after the last call of a burst. */
export const debounced = (
  delay: number,
  run: () => void,
): (() => void) & { cancel: () => void } => {
  let handle: ReturnType<typeof setTimeout> | null = null;
  const call = () => {
    if (handle !== null) clearTimeout(handle);
    handle = setTimeout(() => {
      handle = null;
      run();
    }, delay);
  };
  call.cancel = () => {
    if (handle !== null) clearTimeout(handle);
    handle = null;
  };
  return call;
};
