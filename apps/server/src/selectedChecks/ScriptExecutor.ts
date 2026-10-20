// @effect-diagnostics nodeBuiltinImport:off - This module is the single owner
// of the process groups it spawns: detached leaders, pgid probing/signalling,
// and raw stream hashing all happen at the Node boundary on purpose so no
// opaque shared supervisor can emit late signals after a group was observed
// gone.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import type * as NodeStream from "node:stream";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Runs one registered check as `<shell> -lc <command>` under a detached POSIX
 * leader (pgid = leader pid) and reports evidence about how the leader and its
 * process group ended.
 *
 * Ownership: once Node exposes a pid, the captured group is owned until the
 * bounded observation in this module ends — a failed spawn ack, an ack
 * timeout, or an interrupted fiber never erases that ownership. Group
 * observation is probe-first: a signal is only sent right after an `exists`
 * probe, and once `gone` is latched the pgid is never probed or signalled
 * again — the latch is synchronous at the observation site and keeps the
 * provenance of the last delivered signal. After a delivered TERM/KILL an
 * `unknown` probe forbids all later nonzero signals while the same phase
 * window keeps probing for ESRCH; a pre-intervention `unknown` or a denied
 * signal stays terminal on every entry and reentry.
 *
 * Stop semantics: the cooperative `cancelSignal` is the only stop mechanism
 * that produces a result. An external fiber interruption produces no result;
 * the release path still runs bounded group observation so the group is never
 * stranded.
 *
 * Scope of the guarantee: the executor owns exactly one captured process
 * group — the group created by the spawned leader. A descendant that leaves
 * that group (`setsid`/`setpgid`) and also closes every inherited pipe is
 * unobservable: the group can report `empty` and a run can still `pass` while
 * such an escapee keeps running. A group-escaped descendant that keeps an
 * inherited pipe open is still caught, because stdout/stderr then never reach
 * EOF and the run cannot pass.
 *
 * Data boundary: the command text, output bytes, and raw error causes never
 * leave this module. Results carry sha256 digests + byte counts for fully
 * drained streams, fixed failure codes, and the captured pgid so a later
 * service can record ownership evidence without inheriting any secret data.
 */

export interface StreamDigest {
  readonly bytes: number;
  readonly sha256: string;
}

export type ScriptExecutionGroup = "not-started" | "empty" | "terminated" | "killed" | "unknown";

export type ScriptExecutionExitedBy = "exit" | "signal" | "timeout" | "cancel" | "spawn-failed";

export type ScriptExecutionFailure =
  | "spawn-failed"
  | "stream-failed"
  | "signaled"
  | "cleanup-denied"
  | "cleanup-timeout";

export type ScriptExecutionStatus = "passed" | "failed" | "timed-out" | "cancelled" | "unproven";

export interface ScriptExecutionResult {
  readonly status: ScriptExecutionStatus;
  /** Integer exit code, or null when the leader died by signal or never exited. */
  readonly exitCode: number | null;
  /** What ended the leader wait; a late exit cannot rewrite it. */
  readonly exitedBy: ScriptExecutionExitedBy;
  /** Signal name (e.g. "SIGTERM") when the leader died by signal. */
  readonly exitSignal: string | null;
  /** Captured process group id (leader pid), for service-level ownership records. */
  readonly pgid: number | null;
  readonly group: ScriptExecutionGroup;
  readonly stdout: StreamDigest | null;
  readonly stderr: StreamDigest | null;
  readonly failure: ScriptExecutionFailure | null;
}

export type GroupProbeResult = "exists" | "gone" | "unknown";
export type GroupSignalResult = "ok" | "gone" | "denied";

export interface ScriptExecutionDeps {
  readonly probeGroup: (pgid: number) => GroupProbeResult;
  readonly signalGroup: (pgid: number, signal: "SIGTERM" | "SIGKILL") => GroupSignalResult;
  readonly now: () => number;
}

export interface ScriptExecutionTimings {
  /**
   * Bound on waiting for the child 'spawn'/'error' acknowledgement. `<= 0`
   * forces an immediate ack-timeout outcome (deterministic injection seam).
   */
  readonly spawnAckMs: number;
  /** Grace for same-group members to exit on their own after the leader wait. */
  readonly settleMs: number;
  readonly probeIntervalMs: number;
  /** Observation window after SIGTERM before escalating to SIGKILL. */
  readonly termObserveMs: number;
  /** Observation window after SIGKILL before giving up. */
  readonly killObserveMs: number;
  /** How long to wait for stdout/stderr EOF after group observation. */
  readonly eofMs: number;
}

export interface ScriptExecutionInput {
  /** Absolute path of the POSIX shell used as `shell -lc <command>`. */
  readonly shell: string;
  /** Command text. Never leaves this module — not in results, errors, or logs. */
  readonly command: string;
  readonly cwd: string;
  /** Extra environment entries, merged over this process's environment. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Bound on waiting for the leader exit (ms). */
  readonly timeoutMs: number;
  /**
   * Cooperative cancellation. Completing it before spawn prevents the run
   * entirely; completing it mid-run latches `cancelled` (cancellation wins
   * over a latched timeout) and the run still returns after bounded group
   * observation plus the EOF deadline.
   */
  readonly cancelSignal?: Deferred.Deferred<void> | undefined;
  readonly timings?: Partial<ScriptExecutionTimings> | undefined;
  readonly deps?: Partial<ScriptExecutionDeps> | undefined;
}

const DEFAULT_TIMINGS: ScriptExecutionTimings = {
  spawnAckMs: 5_000,
  settleMs: 1_000,
  probeIntervalMs: 10,
  termObserveMs: 5_000,
  killObserveMs: 1_000,
  eofMs: 1_000,
};

const spawnFailedResult = (): ScriptExecutionResult => ({
  status: "unproven",
  exitCode: null,
  exitedBy: "spawn-failed",
  exitSignal: null,
  pgid: null,
  group: "not-started",
  stdout: null,
  stderr: null,
  failure: "spawn-failed",
});

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { readonly code: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;

const defaultDeps: ScriptExecutionDeps = {
  // Signal 0 delivers nothing; it only reports whether the group exists.
  // EPERM or any other error means we cannot prove the group's state.
  probeGroup: (pgid) => {
    try {
      process.kill(-pgid, 0);
      return "exists";
    } catch (error) {
      return errorCode(error) === "ESRCH" ? "gone" : "unknown";
    }
  },
  signalGroup: (pgid, signal) => {
    try {
      process.kill(-pgid, signal);
      return "ok";
    } catch (error) {
      return errorCode(error) === "ESRCH" ? "gone" : "denied";
    }
  },
  now: () => performance.now(),
};

// Injected deps may throw; a throwing probe/signal is denied evidence, never a
// crash and never a pass.
const probe = (deps: ScriptExecutionDeps, pgid: number): GroupProbeResult => {
  try {
    return deps.probeGroup(pgid);
  } catch {
    return "unknown";
  }
};

const signal = (
  deps: ScriptExecutionDeps,
  pgid: number,
  sig: "SIGTERM" | "SIGKILL",
): GroupSignalResult => {
  try {
    return deps.signalGroup(pgid, sig);
  } catch {
    return "denied";
  }
};

interface ExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
}

interface StreamDrain {
  readonly completion: Deferred.Deferred<StreamDigest, "failed">;
  readonly stream: NodeStream.Readable | null;
}

// Reads one child stream to EOF, updating only a sha256 and a byte count —
// output text is never stored. An 'end' event completes with the digest; an
// 'error' event, or 'close' without 'end', marks the drain failed.
const startDrain = (stream: NodeStream.Readable): StreamDrain => {
  const completion = Deferred.makeUnsafe<StreamDigest, "failed">();
  const hash = NodeCrypto.createHash("sha256");
  let bytes = 0;
  let settled = false;
  const settle = (effect: Effect.Effect<StreamDigest, "failed">) => {
    if (settled) return;
    settled = true;
    // Keep an error listener armed so a late 'error' after the drain settled
    // (including our own destroy) cannot surface as an unhandled event.
    stream.on("error", () => {});
    Deferred.doneUnsafe(completion, effect);
  };
  stream.on("data", (chunk: Uint8Array) => {
    bytes += chunk.byteLength;
    hash.update(chunk);
  });
  stream.once("end", () => settle(Effect.succeed({ bytes, sha256: hash.digest("hex") })));
  stream.once("error", () => settle(Effect.fail("failed" as const)));
  stream.once("close", () => settle(Effect.fail("failed" as const)));
  return { completion, stream };
};

const failedDrain = (): StreamDrain => {
  const completion = Deferred.makeUnsafe<StreamDigest, "failed">();
  Deferred.doneUnsafe(completion, Effect.fail("failed" as const));
  return { completion, stream: null };
};

type Intervention = "none" | "term" | "kill";

// Shared per-attempt cleanup bookkeeping. Every field is written only at a
// synchronous observation boundary — inside the probe/signal wrapper or the
// phase initializer — so a pass interrupted into release sees the exact same
// terminal facts the interrupted pass recorded.
interface CleanupState {
  /** First `gone` ever observed; probes short-circuit without an OS call. */
  knownGone: boolean;
  /**
   * First `unknown` probe or `denied` signal; never cleared, so no nonzero
   * signal is sent afterward even if a later probe reports `exists`.
   */
  signalsForbidden: boolean;
  /** The last signal that returned `ok`; the provenance of any later `gone`. */
  intervened: Intervention;
  /** The active phase, recorded before that phase's first yield. */
  phase: "settle" | "send-term" | "term" | "send-kill" | "kill" | "done" | null;
  /** Absolute monotonic deadline of the active observation window. */
  deadline: number;
  /**
   * The active window admitted at least one `exists` observation — the only
   * authority the next nonzero signal ever has. Reset when a phase opens;
   * preserved across interruption.
   */
  phaseHasExists: boolean;
}

interface SpawnAttempt {
  readonly child: NodeChildProcess.ChildProcess;
  readonly exitDone: Deferred.Deferred<ExitInfo>;
  readonly ackDone: Deferred.Deferred<"spawned" | "error">;
  readonly processErrored: { value: boolean };
  readonly cleanup: CleanupState;
  /** Set once a cleanup pass completed; gates the release's pass. */
  readonly disposed: { value: boolean };
  readonly stdout: StreamDrain;
  readonly stderr: StreamDrain;
}

// Spawns the detached leader and wires every listener and drain in the same
// tick, so no event can be lost and ownership transfers atomically to the
// bracket that awaits. Returns null only when Node proved no process could be
// created (synchronous spawn throw) — 'error' and missing acks resolve through
// the normal result path so raw causes stay inside this module.
const spawnAttempt = (input: ScriptExecutionInput): Effect.Effect<SpawnAttempt | null> =>
  Effect.sync(() => {
    let child: NodeChildProcess.ChildProcess;
    try {
      child = NodeChildProcess.spawn(input.shell, ["-lc", input.command], {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
    const exitDone = Deferred.makeUnsafe<ExitInfo>();
    const ackDone = Deferred.makeUnsafe<"spawned" | "error">();
    const processErrored = { value: false };
    child.on("error", () => {
      processErrored.value = true;
      Deferred.doneUnsafe(ackDone, Effect.succeed("error" as const));
    });
    child.once("spawn", () => {
      Deferred.doneUnsafe(ackDone, Effect.succeed("spawned" as const));
    });
    const recordExit = (code: number | null, signal: NodeJS.Signals | null) => {
      Deferred.doneUnsafe(exitDone, Effect.succeed({ code, signal }));
    };
    child.once("exit", recordExit);
    child.once("close", recordExit);
    return {
      child,
      exitDone,
      ackDone,
      processErrored,
      cleanup: {
        knownGone: false,
        signalsForbidden: false,
        intervened: "none",
        phase: null,
        deadline: 0,
        phaseHasExists: false,
      },
      disposed: { value: false },
      stdout: child.stdout === null ? failedDrain() : startDrain(child.stdout),
      stderr: child.stderr === null ? failedDrain() : startDrain(child.stderr),
    };
  });

type AckOutcome = "spawned" | "spawn-error" | "ack-timeout";

const awaitSpawnAck = (attempt: SpawnAttempt, spawnAckMs: number): Effect.Effect<AckOutcome> =>
  spawnAckMs <= 0
    ? Effect.succeed("ack-timeout")
    : Effect.raceAll([
        Deferred.await(attempt.ackDone).pipe(
          Effect.map((ack): AckOutcome => (ack === "spawned" ? "spawned" : "spawn-error")),
        ),
        Effect.sleep(spawnAckMs).pipe(Effect.as("ack-timeout" as const)),
      ]);

interface GroupObserver {
  readonly state: CleanupState;
  readonly now: () => number;
  readonly probe: (pgid: number) => GroupProbeResult;
  readonly signal: (pgid: number, sig: "SIGTERM" | "SIGKILL") => GroupSignalResult;
}

// The observation latches are written in the same synchronous code path that
// receives a probe or signal result — before the result crosses a yield
// boundary — so an interrupted pass can never re-derive a terminal fact or
// regain signal authority. A `knownGone` probe short-circuits without an OS
// call, and a delivered `ok` records its intervention plus the phase and
// absolute deadline it opens.
const groupObserver = (
  deps: ScriptExecutionDeps,
  timings: ScriptExecutionTimings,
  state: CleanupState,
): GroupObserver => ({
  state,
  now: deps.now,
  probe: (pgid) => {
    if (state.knownGone) return "gone";
    const outcome = probe(deps, pgid);
    if (outcome === "gone") state.knownGone = true;
    else if (outcome === "unknown") state.signalsForbidden = true;
    else state.phaseHasExists = true;
    return outcome;
  },
  signal: (pgid, sig) => {
    if (state.knownGone || state.signalsForbidden) return "denied";
    const outcome = signal(deps, pgid, sig);
    if (outcome === "gone") {
      state.knownGone = true;
    } else if (outcome === "denied") {
      state.signalsForbidden = true;
    } else {
      state.intervened = sig === "SIGKILL" ? "kill" : "term";
      state.phase = sig === "SIGKILL" ? "kill" : "term";
      state.deadline =
        deps.now() + (sig === "SIGKILL" ? timings.killObserveMs : timings.termObserveMs);
      state.phaseHasExists = false;
    }
    return outcome;
  },
});

// Signal-0 probes until a terminal observation or the phase's absolute
// monotonic deadline. The stored deadline gates every probe — the phase's
// opening probe, a resumed phase's next probe, and the first probe after
// each wake — so an already-elapsed window admits nothing. `stopOnUnknown`
// ends pre-intervention windows on the first denied probe; post-intervention
// windows keep probing through `unknown`, which already latched
// `signalsForbidden`, so a later `exists` can never restore signal authority.
const observeWindow = Effect.fnUntraced(function* (
  observer: GroupObserver,
  timings: ScriptExecutionTimings,
  pgid: number,
  deadline: number,
  stopOnUnknown: boolean,
): Effect.fn.Return<void> {
  for (;;) {
    const remaining = deadline - observer.now();
    if (remaining <= 0) return;
    const outcome = observer.probe(pgid);
    if (outcome === "gone" || (stopOnUnknown && outcome === "unknown")) return;
    yield* Effect.sleep(Math.min(timings.probeIntervalMs, remaining));
  }
});

interface CleanupOutcome {
  readonly group: "empty" | "terminated" | "killed" | "unknown";
  readonly failure: "cleanup-denied" | "cleanup-timeout" | null;
}

// The group a `gone` belongs to, derived from the last delivered signal: a
// post-intervention ESRCH is never relabelled natural empty, and a signal
// returning ESRCH with no prior `ok` keeps provenance none → empty.
const provenanceGroup = (intervened: Intervention): "empty" | "terminated" | "killed" =>
  intervened === "kill" ? "killed" : intervened === "term" ? "terminated" : "empty";

// One resumable bounded pass over the captured group. Each observation
// window is initialized exactly once with its absolute deadline stored in
// shared state, and each delivered signal synchronously opens the next phase
// inside the observer — so a pass interrupted into release resumes the same
// phase with its remaining time, never repeats a delivered signal, and never
// opens a fresh window. Recovery after a delivered TERM/KILL is probe-only:
// an `unknown` forbids further nonzero signals while the same window keeps
// probing for ESRCH.
const observeCleanup = Effect.fnUntraced(function* (
  observer: GroupObserver,
  timings: ScriptExecutionTimings,
  pgid: number,
): Effect.fn.Return<CleanupOutcome> {
  const state = observer.state;
  for (;;) {
    if (state.knownGone) return { group: provenanceGroup(state.intervened), failure: null };
    if (state.signalsForbidden && state.intervened === "none") {
      // A pre-intervention unknown or a denied signal is terminal here and
      // on every reentry — never a fresh recovery attempt.
      return { group: "unknown", failure: "cleanup-denied" };
    }
    if (state.phase === null) {
      state.phase = "settle";
      state.deadline = observer.now() + timings.settleMs;
      state.phaseHasExists = false;
    }

    switch (state.phase) {
      case "settle":
      case "term":
      case "kill": {
        yield* observeWindow(observer, timings, pgid, state.deadline, state.phase === "settle");
        if (state.knownGone) continue;
        if (state.signalsForbidden) {
          return { group: "unknown", failure: "cleanup-denied" };
        }
        // A nonzero signal needs this window's own `exists` observation —
        // an elapsed window that admitted no probe, or only denied ones,
        // authorizes nothing and closes the pass unresolved instead of
        // inventing exists evidence or signalling blind.
        if (state.phase === "kill" || !state.phaseHasExists) {
          state.phase = "done";
          return { group: "unknown", failure: "cleanup-timeout" };
        }
        state.phase = state.phase === "settle" ? "send-term" : "send-kill";
        continue;
      }
      case "send-term":
      case "send-kill": {
        const outcome = observer.signal(pgid, state.phase === "send-kill" ? "SIGKILL" : "SIGTERM");
        if (outcome === "denied") {
          return { group: "unknown", failure: "cleanup-denied" };
        }
        // "ok" already opened the next phase synchronously inside the
        // observer; "gone" resolves at the loop's knownGone check.
        continue;
      }
      case "done": {
        return { group: "unknown", failure: "cleanup-timeout" };
      }
      case null: {
        continue;
      }
    }
  }
});

interface DrainOutcome {
  readonly digest: StreamDigest | null;
  readonly failed: boolean;
}

// Waits for one drain until EOF or the shared EOF deadline. A stream error or
// premature close reports failed; a deadline lapse only means the digest is
// absent — it is not stream-failed.
const awaitDrain = (
  drain: StreamDrain,
  deadlineMs: number,
  now: () => number,
): Effect.Effect<DrainOutcome> =>
  Deferred.await(drain.completion).pipe(
    Effect.timeoutOption(Math.max(0, deadlineMs - now())),
    Effect.match({
      onFailure: (): DrainOutcome => ({ digest: null, failed: true }),
      onSuccess: (option): DrainOutcome => ({ digest: Option.getOrNull(option), failed: false }),
    }),
  );

type WaitOutcome =
  | { readonly kind: "exit"; readonly exit: ExitInfo }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancel" }
  | { readonly kind: "spawn-failed" };

const leaderWait = (
  input: ScriptExecutionInput,
  attempt: SpawnAttempt,
): Effect.Effect<WaitOutcome> =>
  Effect.raceAll([
    Deferred.await(attempt.exitDone).pipe(
      Effect.map((exit): WaitOutcome => ({ kind: "exit", exit })),
    ),
    Effect.sleep(Math.max(0, input.timeoutMs)).pipe(Effect.as({ kind: "timeout" } as WaitOutcome)),
    (input.cancelSignal === undefined ? Effect.never : Deferred.await(input.cancelSignal)).pipe(
      Effect.as({ kind: "cancel" } as WaitOutcome),
    ),
  ]);

// Produces the result for an owned attempt: group observation, bounded EOF
// wait, then fixed-code classification. `cleanup`/`disposed` share the
// attempt's terminal state with the release path.
const finishRun = Effect.fnUntraced(function* (
  input: ScriptExecutionInput,
  deps: ScriptExecutionDeps,
  timings: ScriptExecutionTimings,
  attempt: SpawnAttempt,
): Effect.fn.Return<ScriptExecutionResult> {
  const ack = yield* awaitSpawnAck(attempt, timings.spawnAckMs);
  const pgid = attempt.child.pid;
  // No pid materialised through the ack path: Node proved no process exists,
  // which is the only outcome allowed to report not-started.
  if (typeof pgid !== "number") return spawnFailedResult();

  const waitOutcome: WaitOutcome =
    ack === "spawned" ? yield* leaderWait(input, attempt) : { kind: "spawn-failed" };

  const cleanup = yield* observeCleanup(
    groupObserver(deps, timings, attempt.cleanup),
    timings,
    pgid,
  );
  attempt.disposed.value = true;

  const eofDeadline = deps.now() + timings.eofMs;
  const [stdout, stderr] = yield* Effect.all(
    [
      awaitDrain(attempt.stdout, eofDeadline, deps.now),
      awaitDrain(attempt.stderr, eofDeadline, deps.now),
    ],
    { concurrency: "unbounded" },
  );

  yield* Effect.sync(() => {
    attempt.stdout.stream?.destroy();
    attempt.stderr.stream?.destroy();
    attempt.child.unref();
  });

  // A 'close' that raced the EOF deadline still lands in the result.
  const exitRecorded = yield* Deferred.isDone(attempt.exitDone);
  const exitInfo = exitRecorded ? yield* Deferred.await(attempt.exitDone) : undefined;
  const cancelRequested =
    input.cancelSignal === undefined ? false : yield* Deferred.isDone(input.cancelSignal);

  const exitCode = exitInfo?.code ?? null;
  const exitSignal = exitInfo?.signal ?? null;
  const timedOut = waitOutcome.kind === "timeout";
  const spawnFailed = waitOutcome.kind === "spawn-failed";
  const streamFailed = stdout.failed || stderr.failed;
  const signaled = exitInfo !== undefined && exitInfo.signal !== null;
  const failure: ScriptExecutionFailure | null = spawnFailed
    ? "spawn-failed"
    : streamFailed
      ? "stream-failed"
      : signaled
        ? "signaled"
        : (cleanup.failure ?? (attempt.processErrored.value ? "spawn-failed" : null));
  const exitedBy: ScriptExecutionExitedBy =
    waitOutcome.kind === "exit"
      ? exitInfo !== undefined && exitInfo.code === null && exitInfo.signal !== null
        ? "signal"
        : "exit"
      : waitOutcome.kind;

  // Sticky terminal reason: cancellation latched before finalization wins over
  // a latched timeout, and neither can be rewritten by a late exit code.
  const status: ScriptExecutionStatus = cancelRequested
    ? "cancelled"
    : timedOut
      ? "timed-out"
      : spawnFailed
        ? "unproven"
        : exitCode === 0 &&
            cleanup.group === "empty" &&
            stdout.digest !== null &&
            stderr.digest !== null &&
            failure === null
          ? "passed"
          : exitCode !== null && exitCode !== 0
            ? "failed"
            : "unproven";

  return {
    status,
    exitCode,
    exitedBy,
    exitSignal,
    pgid,
    group: cleanup.group,
    stdout: stdout.digest,
    stderr: stderr.digest,
    failure,
  };
});

// Release path for every exit that skipped or interrupted finishing — an ack
// hang, or a fiber interrupted while it owned a live group. If `disposed` is
// still unset, the resumable pass continues from the shared state: a
// delivered signal is never repeated, a `gone` never re-probed, and a
// forbidden attempt never regains nonzero signal authority.
const releaseAttempt = Effect.fnUntraced(function* (
  attempt: SpawnAttempt,
  deps: ScriptExecutionDeps,
  timings: ScriptExecutionTimings,
): Effect.fn.Return<void> {
  if (!attempt.disposed.value && typeof attempt.child.pid === "number") {
    yield* observeCleanup(
      groupObserver(deps, timings, attempt.cleanup),
      timings,
      attempt.child.pid,
    );
    attempt.disposed.value = true;
  }
  yield* Effect.sync(() => {
    attempt.stdout.stream?.destroy();
    attempt.stderr.stream?.destroy();
    attempt.child.unref();
  });
});

export const runScript = Effect.fnUntraced(function* (
  input: ScriptExecutionInput,
): Effect.fn.Return<ScriptExecutionResult> {
  const timings: ScriptExecutionTimings = { ...DEFAULT_TIMINGS, ...input.timings };
  const deps: ScriptExecutionDeps = { ...defaultDeps, ...input.deps };

  // A stop requested before spawn must not start script side effects.
  if (input.cancelSignal !== undefined && (yield* Deferred.isDone(input.cancelSignal))) {
    return {
      status: "cancelled",
      exitCode: null,
      exitedBy: "cancel",
      exitSignal: null,
      pgid: null,
      group: "not-started",
      stdout: null,
      stderr: null,
      failure: null,
    };
  }

  // The bracket hands ownership atomically: acquire and use share one
  // uninterruptible boundary, and release runs bounded cleanup on any exit,
  // including interruption, so a spawned group is never stranded or erased.
  return yield* Effect.acquireUseRelease(
    spawnAttempt(input),
    (attempt) =>
      attempt === null
        ? Effect.succeed(spawnFailedResult())
        : finishRun(input, deps, timings, attempt),
    (attempt) => (attempt === null ? Effect.void : releaseAttempt(attempt, deps, timings)),
  );
});
