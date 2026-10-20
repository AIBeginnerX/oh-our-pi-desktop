// @effect-diagnostics nodeBuiltinImport:off - These tests run real POSIX
// processes: latches live in a real temp dir, hashes come from node:crypto,
// and teardown reaps exactly the pgids/pids this suite captured.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";

import * as ScriptExecutor from "./ScriptExecutor.ts";

const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const SHELL = "/bin/sh";
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// Bounded windows sized for a test process on a loaded host, still far below
// the default test timeout. Cleanup escalation exercises real TERM/KILL timing.
const FAST_TIMINGS: ScriptExecutor.ScriptExecutionTimings = {
  spawnAckMs: 5_000,
  settleMs: 250,
  probeIntervalMs: 5,
  termObserveMs: 400,
  killObserveMs: 200,
  eofMs: 300,
};

interface Tracked {
  readonly dir: string;
  readonly pgids: number[];
  readonly pids: number[];
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const groupAlive = (pgid: number): boolean => pidAlive(-pgid);

// Only positive safe integers ever reach the tracking lists — a malformed or
// reused number never becomes a bookkeeping entry.
const validId = (id: number | null): id is number =>
  typeof id === "number" && Number.isSafeInteger(id) && id > 0;

// Cleanup only ever waits. Fixtures are finite and self-bounded, so teardown
// waits (bounded) for captured targets to expire on their own, then removes
// the temp dir. It never signals: a captured pgid/pid is historical the
// moment the run returns, and a later liveness probe cannot re-establish that
// the original fixture still owns the number.
const tracked = Effect.acquireRelease(
  Effect.sync((): Tracked => ({
    dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-scx-")),
    pgids: [],
    pids: [],
  })),
  (t) =>
    Effect.gen(function* () {
      const deadline = performance.now() + 8_000;
      for (const pgid of t.pgids) {
        while (groupAlive(pgid) && performance.now() < deadline) yield* Effect.sleep(10);
      }
      for (const pid of t.pids) {
        while (pidAlive(pid) && performance.now() < deadline) yield* Effect.sleep(10);
      }
      NodeFS.rmSync(t.dir, { recursive: true, force: true });
    }),
);

const run = (
  input: { readonly command: string } & Partial<
    Omit<ScriptExecutor.ScriptExecutionInput, "command" | "timings">
  > & { readonly timings?: Partial<ScriptExecutor.ScriptExecutionTimings> | undefined },
) =>
  ScriptExecutor.runScript({
    shell: SHELL,
    cwd: NodeOS.tmpdir(),
    timeoutMs: 30_000,
    ...input,
    timings: { ...FAST_TIMINGS, ...input.timings },
  });

// Registers a result group only when liveness is unproven — the bounded wait
// then covers the fixture's remaining finite lifetime. A group already
// observed empty/terminated/killed is historical and never tracked again.
// Live targets captured from fixture latches are pushed to `t.pgids`/`t.pids`
// directly at readiness, before awaited assertions.
const track = (t: Tracked, result: ScriptExecutor.ScriptExecutionResult) => {
  if (result.group === "unknown" && validId(result.pgid)) t.pgids.push(result.pgid);
};

// File latches give deterministic readiness between leader and group members
// without leaving long sleepers behind.
const waitForFile = Effect.fnUntraced(function* (path: string): Effect.fn.Return<boolean> {
  const deadline = performance.now() + 5_000;
  while (!NodeFS.existsSync(path)) {
    if (performance.now() > deadline) return false;
    yield* Effect.sleep(10);
  }
  return true;
});

// Pid latches are written by the fixture itself; an existing-but-empty file is
// not readiness, so poll for parseable content.
const waitForPid = Effect.fnUntraced(function* (path: string): Effect.fn.Return<number | null> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      const text = NodeFS.readFileSync(path, "utf8").trim();
      if (text.length > 0) {
        const parsed = Number(text);
        return validId(parsed) ? parsed : null;
      }
    } catch {
      // Not written yet.
    }
    if (performance.now() > deadline) return null;
    yield* Effect.sleep(10);
  }
});

const sha256Of = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const errnoName = (error: unknown): string | null =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  typeof (error as { readonly code: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : null;

interface GroupOp {
  readonly op: "probe" | "SIGTERM" | "SIGKILL";
  readonly ms: number;
  readonly outcome: string;
  readonly errno: string | null;
}

// Test-local delegate over the real process.kill(-pgid, …) calls, using the
// same errno mapping as the executor's default deps (ESRCH → gone, anything
// else → unknown/denied; a throw is the only failure shape). It records one
// safe entry per call — operation/signal, relative ms, mapped outcome, fixed
// errno name — so a failing run shows which stage denied, not just that it
// did. No command text, environment, output, or raw errors are recorded.
const realGroupOps = (): {
  readonly ops: GroupOp[];
  readonly deps: Partial<ScriptExecutor.ScriptExecutionDeps>;
} => {
  const ops: GroupOp[] = [];
  const started = performance.now();
  const ms = () => Math.round(performance.now() - started);
  return {
    ops,
    deps: {
      probeGroup: (pgid) => {
        try {
          process.kill(-pgid, 0);
          ops.push({ op: "probe", ms: ms(), outcome: "exists", errno: null });
          return "exists";
        } catch (error) {
          const errno = errnoName(error);
          const outcome = errno === "ESRCH" ? "gone" : "unknown";
          ops.push({ op: "probe", ms: ms(), outcome, errno });
          return outcome;
        }
      },
      signalGroup: (pgid, sig) => {
        try {
          process.kill(-pgid, sig);
          ops.push({ op: sig, ms: ms(), outcome: "ok", errno: null });
          return "ok";
        } catch (error) {
          const errno = errnoName(error);
          const outcome = errno === "ESRCH" ? "gone" : "denied";
          ops.push({ op: sig, ms: ms(), outcome, errno });
          return outcome;
        }
      },
    },
  };
};

// After a delivered TERM the pass admits only signal-0 probes: an ESRCH/gone
// observation ends it as terminated, while any `unknown` forbids all later
// nonzero signals so a window that closes unresolved stays cleanup-denied.
// A signal op after TERM, a missing TERM, or a trace that ends without a
// gone-or-unknown observation is a failure, not a third outcome.
const postTermBranch = (ops: ReadonlyArray<GroupOp>): "terminated" | "denied" => {
  const termIndex = ops.findIndex((op) => op.op === "SIGTERM");
  const observedFirst =
    termIndex > 0 &&
    ops.slice(0, termIndex).every((op) => op.op === "probe" && op.outcome === "exists");
  if (!observedFirst || ops[termIndex]?.outcome !== "ok") {
    expect.unreachable(`unexpected group-op trace: ${JSON.stringify(ops)}`);
  }
  const after = ops.slice(termIndex + 1);
  const last = after[after.length - 1];
  if (after.length === 0 || after.some((op) => op.op !== "probe") || last?.op !== "probe") {
    expect.unreachable(`non-probe op after TERM: ${JSON.stringify(after)}`);
  }
  if (last.outcome === "gone" && last.errno === "ESRCH") return "terminated";
  if (after.some((op) => op.outcome === "unknown" && op.errno === "EPERM")) return "denied";
  expect.unreachable(`unresolved post-TERM trace: ${JSON.stringify(after)}`);
};

// A deterministic group script: every probe advances the injected monotonic
// clock by `stepMs`, so each observation window closes after an exact number
// of calls. Signal calls are recorded, never delivered — there is no second
// cleanup authority in the harness.
const scriptedGroup = (
  script: ReadonlyArray<"exists" | "gone" | "unknown">,
  stepMs: number,
): {
  readonly deps: Partial<ScriptExecutor.ScriptExecutionDeps>;
  readonly signals: Array<"SIGTERM" | "SIGKILL">;
  readonly probes: () => number;
} => {
  let now = 0;
  let count = 0;
  const signals: Array<"SIGTERM" | "SIGKILL"> = [];
  return {
    signals,
    probes: () => count,
    deps: {
      now: () => now,
      probeGroup: () => {
        count += 1;
        now += stepMs;
        return script[Math.min(count - 1, script.length - 1)]!;
      },
      signalGroup: (_pgid, signal) => {
        signals.push(signal);
        return "ok";
      },
    },
  };
};

// Polls a test-local latch — readiness for forked fixtures without real-time
// guesses.
const waitUntil = Effect.fnUntraced(function* (
  condition: () => boolean,
): Effect.fn.Return<boolean> {
  const deadline = performance.now() + 5_000;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    yield* Effect.sleep(5);
  }
  return true;
});

// The escapee launcher: the leader runs a node process that spawns a detached
// grandchild (its own session/group, so unobservable to the leader's group),
// writes the real pid to the latch, and unrefs it. Finite 3s lifetime bounds
// the fixture even if teardown never reaches it.
const escapeeLauncher = (stdio: string, pidFileVar: string) =>
  `"$LAUNCH_EXE" -e 'const c=require("node:child_process").spawn(process.execPath,` +
  `["-e","setTimeout(()=>{},3000)"],{detached:true,stdio:${stdio}});` +
  `require("node:fs").writeFileSync(process.env.${pidFileVar},String(c.pid));c.unref()'; exit 0`;

describe("ScriptExecutor", () => {
  it.live.skipIf(windowsHost)(
    "passes a zero-exit leader with digested empty streams and an empty group",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const result = yield* run({ command: "true" });
        track(t, result);
        expect(result).toMatchObject({
          status: "passed",
          exitCode: 0,
          exitedBy: "exit",
          exitSignal: null,
          group: "empty",
          stdout: { bytes: 0, sha256: EMPTY_SHA256 },
          stderr: { bytes: 0, sha256: EMPTY_SHA256 },
          failure: null,
        });
        expect(result.pgid).toBeGreaterThan(0);
        expect(Number.isInteger(result.pgid)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("fails a nonzero leader exit", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const result = yield* run({ command: "exit 3" });
      track(t, result);
      expect(result).toMatchObject({
        status: "failed",
        exitCode: 3,
        exitedBy: "exit",
        exitSignal: null,
        group: "empty",
        failure: null,
      });
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "does not pass a zero-exit leader while a same-group member remains",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const result = yield* run({ command: "sleep 5 >/dev/null 2>&1 & exit 0" });
        track(t, result);
        // Leader exited 0, but the orphaned same-group sleep was observed and
        // terminated — the run is unproven, never passed.
        expect(result).toMatchObject({
          status: "unproven",
          exitCode: 0,
          exitedBy: "exit",
          group: "terminated",
          failure: null,
        });
        // The member dropped the inherited pipes, so EOF still proved digests.
        expect(result.stdout).toEqual({ bytes: 0, sha256: EMPTY_SHA256 });
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "digests a pipe-holding member's output while reporting observed cleanup evidence",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const trace = realGroupOps();
        const result = yield* run({
          command: "(printf 'x'; sleep 5) & exit 0",
          deps: trace.deps,
        });
        track(t, result);
        // The member wrote its byte before the leader exited; the drain must
        // complete whichever cleanup branch the host produced.
        expect(result.stdout).toEqual({ bytes: 1, sha256: sha256Of(new Uint8Array([0x78])) });
        expect(result.stderr).toEqual({ bytes: 0, sha256: EMPTY_SHA256 });
        const branch = postTermBranch(trace.ops);
        // Host evidence for the parent: whether an EPERM denial ever resolves
        // to ESRCH inside the bounded window lives in the post-TERM tail.
        console.log(
          JSON.stringify({
            case: "pipe-member",
            branch,
            group: result.group,
            postTerm: trace.ops.slice(trace.ops.findIndex((op) => op.op === "SIGTERM") + 1),
          }),
        );
        if (branch === "terminated") {
          expect(result).toMatchObject({
            status: "unproven",
            exitCode: 0,
            group: "terminated",
            failure: null,
          });
        } else {
          expect(result).toMatchObject({
            status: "unproven",
            exitCode: 0,
            group: "unknown",
            failure: "cleanup-denied",
          });
        }
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "escalates to SIGKILL for a TERM-ignoring group member that keeps the pipes",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const readyPath = NodePath.join(t.dir, "child-ready");
        const result = yield* run({
          // The stubborn member is a node process whose own caught SIGTERM
          // handler stays armed for its whole lifetime.
          command:
            `"$IGN_EXE" -e 'process.on("SIGTERM",()=>{});` +
            `require("node:fs").writeFileSync(process.env.IGN_FILE,"1");` +
            `setTimeout(()=>{},5000)' & ` +
            `i=0; while [ ! -f "$IGN_FILE" ] && [ "$i" -lt 500 ]; do ` +
            `sleep 0.01; i=$((i+1)); done; exit 0`,
          env: { IGN_EXE: process.execPath, IGN_FILE: readyPath },
        });
        track(t, result);
        expect(result).toMatchObject({
          status: "unproven",
          exitCode: 0,
          group: "killed",
          failure: null,
        });
        // SIGKILL releases the held pipes, so EOF still proves empty digests.
        expect(result.stdout).toEqual({ bytes: 0, sha256: EMPTY_SHA256 });
        expect(result.stderr).toEqual({ bytes: 0, sha256: EMPTY_SHA256 });
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "bounds a TERM-ignoring leader through timeout, TERM, then KILL",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const started = performance.now();
        const result = yield* run({
          // The node leader's own caught SIGTERM handler stays armed for its
          // whole lifetime — no dependence on inherited dispositions.
          command: `"$IGN_EXE" -e 'process.on("SIGTERM",()=>{});setTimeout(()=>{},5000)'`,
          env: { IGN_EXE: process.execPath },
          timeoutMs: 300,
        });
        const elapsed = performance.now() - started;
        track(t, result);
        expect(result).toMatchObject({
          status: "timed-out",
          exitCode: null,
          exitedBy: "timeout",
          exitSignal: "SIGKILL",
          group: "killed",
          failure: "signaled",
        });
        expect(result.stdout).toEqual({ bytes: 0, sha256: EMPTY_SHA256 });
        expect(elapsed).toBeLessThan(10_000);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("lets a cooperative cancel outrank a late zero exit", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const readyPath = NodePath.join(t.dir, "leader-ready");
      const cancelSignal = yield* Deferred.make<void>();
      const trace = realGroupOps();
      const fiber = yield* run({
        // A node leader arms its own caught SIGTERM handler (exit 0), writes
        // readiness only after the handler exists, and self-exits at 3s so a
        // failure cannot strand it.
        command:
          `exec "$TERM_EXE" -e 'process.on("SIGTERM",()=>process.exit(0));` +
          `require("node:fs").writeFileSync(process.env.TERM_FILE,"1");` +
          `setTimeout(()=>process.exit(0),3000)'`,
        env: { TERM_EXE: process.execPath, TERM_FILE: readyPath },
        cancelSignal,
        timings: { termObserveMs: 2_000 },
        deps: trace.deps,
      }).pipe(Effect.forkScoped);
      expect(yield* waitForFile(readyPath)).toBe(true);
      yield* Deferred.succeed(cancelSignal, undefined);
      const result = yield* Fiber.join(fiber);
      track(t, result);
      // Strict positive proof: this fixture must show a delivered TERM
      // followed by an ESRCH/gone observation — no adaptive branch here.
      expect(postTermBranch(trace.ops)).toBe("terminated");
      // The executor's TERM lets the armed handler exit 0 inside the
      // observation window — the latched cancel still wins.
      expect(result).toMatchObject({
        status: "cancelled",
        exitedBy: "cancel",
        exitCode: 0,
        group: "terminated",
      });
      expect(result.stdout).toEqual({ bytes: 0, sha256: EMPTY_SHA256 });
      expect(result.stderr).toEqual({ bytes: 0, sha256: EMPTY_SHA256 });
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("keeps a latched timeout under a later cooperative cancel", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const cancelSignal = yield* Deferred.make<void>();
      const fiber = yield* run({
        command: "sleep 5",
        timeoutMs: 200,
        cancelSignal,
        timings: { settleMs: 600, termObserveMs: 800 },
      }).pipe(Effect.forkScoped);
      // The timeout latches at ~200ms while cleanup still observes the group.
      yield* Effect.sleep(400);
      yield* Deferred.succeed(cancelSignal, undefined);
      const result = yield* Fiber.join(fiber);
      track(t, result);
      expect(result.status).toBe("cancelled");
      expect(result.exitedBy).toBe("timeout");
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("never spawns for a cancel requested before the run starts", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const noSpawnPath = NodePath.join(t.dir, "must-not-exist");
      const cancelSignal = yield* Deferred.make<void>();
      yield* Deferred.succeed(cancelSignal, undefined);
      const result = yield* run({
        command: `touch "$NOSP"; sleep 5`,
        env: { NOSP: noSpawnPath },
        cancelSignal,
      });
      track(t, result);
      expect(result).toMatchObject({
        status: "cancelled",
        exitedBy: "cancel",
        pgid: null,
        group: "not-started",
      });
      // No script side effect ran: the marker file the command would create
      // was never written.
      expect(NodeFS.existsSync(noSpawnPath)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "preserves captured ownership through an ack timeout instead of erasing it",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        // spawnAckMs<=0 forces the ack-timeout outcome deterministically; the
        // real pid still exists, so the result must carry it and the group
        // must pass through bounded observation rather than "not-started".
        const trace = realGroupOps();
        const result = yield* run({
          command: "exec sleep 3",
          timings: { spawnAckMs: 0 },
          deps: trace.deps,
        });
        track(t, result);
        // Captured-ownership evidence is asserted independently of how the
        // cleanup observation ended on this host — a positive integer pgid,
        // never not-started.
        expect(result.pgid).toBeGreaterThan(0);
        expect(Number.isInteger(result.pgid)).toBe(true);
        expect(result.group).not.toBe("not-started");
        const branch = postTermBranch(trace.ops);
        // Host evidence for the parent: whether an EPERM denial ever resolves
        // to ESRCH inside the bounded window lives in the post-TERM tail.
        console.log(
          JSON.stringify({
            case: "ack-timeout",
            branch,
            group: result.group,
            postTerm: trace.ops.slice(trace.ops.findIndex((op) => op.op === "SIGTERM") + 1),
          }),
        );
        // spawn-failed intentionally masks the cleanup failure code; only the
        // group evidence differs between branches.
        if (branch === "terminated") {
          expect(result).toMatchObject({
            status: "unproven",
            exitedBy: "spawn-failed",
            failure: "spawn-failed",
            exitCode: null,
            group: "terminated",
          });
        } else {
          expect(result).toMatchObject({
            status: "unproven",
            exitedBy: "spawn-failed",
            failure: "spawn-failed",
            exitCode: null,
            group: "unknown",
          });
        }
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "reaps a live owned group when the fiber is interrupted mid-run",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const pidPath = NodePath.join(t.dir, "leader.pid");
        const fiber = yield* run({
          command: `echo $$ > "$PIDF"; exec sleep 5`,
          env: { PIDF: pidPath },
        }).pipe(Effect.forkScoped);
        // Register the live fixture at readiness, before the awaited
        // interrupt — the entry only buys the bounded wait, never a signal.
        const pgid = yield* waitForPid(pidPath);
        if (validId(pgid)) t.pgids.push(pgid);
        expect(pgid).toBeGreaterThan(0);
        yield* Fiber.interrupt(fiber);
        // Interruption produces no result, but the release path must have run
        // bounded group observation — the captured group is now gone.
        expect(groupAlive(pgid!)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "stops probing and signalling after a gone observation on the interrupted path",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const pidPath = NodePath.join(t.dir, "leader.pid");
        // The fake signals below never touch this fixture; its 3s bound ends
        // it on its own. One settle `exists` reaches TERM, then `gone` at the
        // first post-TERM observation — any third probe or second signal
        // would mean cleanup resumed after the terminal observation.
        const group = scriptedGroup(["exists", "gone"], 10);
        const fiber = yield* run({
          command: `echo $$ > "$PIDF"; exec sleep 3`,
          env: { PIDF: pidPath },
          timings: { settleMs: 1 },
          deps: group.deps,
        }).pipe(Effect.forkScoped);
        const pgid = yield* waitForPid(pidPath);
        if (validId(pgid)) t.pgids.push(pgid);
        expect(pgid).toBeGreaterThan(0);
        // Interrupted while the leader wait is pending, so the release runs
        // the only cleanup pass — deterministically bounded by the script.
        yield* Fiber.interrupt(fiber);
        expect(group.signals).toEqual(["SIGTERM"]);
        expect(group.probes()).toBe(2);
        // The recorded "signals" were fake; the real leader exits on its own
        // bound. Assert group-gone by waiting, never by signalling.
        const deadline = performance.now() + 6_000;
        while (groupAlive(pgid!) && performance.now() < deadline) yield* Effect.sleep(10);
        expect(groupAlive(pgid!)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "refuses to pass when group probing is denied and sends no signals",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const signals: Array<"SIGTERM" | "SIGKILL"> = [];
        const result = yield* run({
          command: "exec sleep 1",
          deps: {
            probeGroup: () => "unknown",
            signalGroup: (_pgid, signal) => {
              signals.push(signal);
              return "ok";
            },
          },
        });
        track(t, result);
        expect(result).toMatchObject({
          status: "unproven",
          group: "unknown",
          failure: "cleanup-denied",
        });
        expect(signals).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "never signals the captured group again after observing it gone",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        // Settle sees members, the term window sees them once, then the group
        // is gone — SIGKILL must never follow.
        const group = scriptedGroup(["exists", "exists", "gone"], 10);
        const result = yield* run({
          command: "exec sleep 1",
          timings: { settleMs: 1 },
          deps: group.deps,
        });
        track(t, result);
        expect(result.group).toBe("terminated");
        expect(result.status).toBe("unproven");
        expect(group.signals).toEqual(["SIGTERM"]);
        expect(group.probes()).toBe(3);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "reports cleanup-denied after bounded probe-only recovery under post-TERM denial",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        // One settle `exists` reaches TERM; the term window then sees unknown
        // until its stored deadline — SIGKILL is never sent.
        const group = scriptedGroup(["exists", "unknown"], 10);
        const result = yield* run({
          command: "exec sleep 1",
          timings: { settleMs: 1 },
          deps: group.deps,
        });
        track(t, result);
        expect(result).toMatchObject({
          status: "unproven",
          exitCode: 0,
          group: "unknown",
          failure: "cleanup-denied",
        });
        expect(group.signals).toEqual(["SIGTERM"]);
        expect(group.probes()).toBe(41);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("recovers a post-TERM unknown to terminated on a later ESRCH", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      // TERM delivered, an unknown, an exists, then gone: provenance stays
      // terminated — a post-intervention ESRCH is never relabeled empty.
      const group = scriptedGroup(["exists", "unknown", "exists", "gone"], 10);
      const result = yield* run({
        command: "exec sleep 1",
        timings: { settleMs: 1 },
        deps: group.deps,
      });
      track(t, result);
      expect(result).toMatchObject({
        status: "unproven",
        exitCode: 0,
        group: "terminated",
        failure: null,
      });
      expect(group.signals).toEqual(["SIGTERM"]);
      expect(group.probes()).toBe(4);
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("admits no further probe once the phase deadline has elapsed", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      // Settle `exists` reaches TERM; the injected clock jumps 5s inside the
      // term window's first probe — the wake finds the deadline already
      // closed and admits no further probe.
      const group = scriptedGroup(["exists", "unknown"], 5_000);
      const result = yield* run({
        command: "exec sleep 1",
        timings: { settleMs: 1 },
        deps: group.deps,
      });
      track(t, result);
      expect(result).toMatchObject({
        status: "unproven",
        exitCode: 0,
        group: "unknown",
        failure: "cleanup-denied",
      });
      expect(group.signals).toEqual(["SIGTERM"]);
      expect(group.probes()).toBe(2);
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "admits no probe at all when every phase deadline is already closed",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        // Each `now()` call lands a second past every stored deadline, so no
        // window — opened or resumed — can admit even its first probe.
        let fakeNow = 0;
        const signals: Array<"SIGTERM" | "SIGKILL"> = [];
        let probes = 0;
        const result = yield* run({
          command: "exec sleep 1",
          timings: { settleMs: 0 },
          deps: {
            now: () => (fakeNow += 1_000),
            probeGroup: () => {
              probes += 1;
              return "gone" as const;
            },
            signalGroup: (_pgid, signal) => {
              signals.push(signal);
              return "ok";
            },
          },
        });
        track(t, result);
        expect(result).toMatchObject({
          status: "unproven",
          exitCode: 0,
          group: "unknown",
          failure: "cleanup-timeout",
        });
        expect(probes).toBe(0);
        // An elapsed window that admitted nothing authorizes nothing — no
        // nonzero signal is ever built on absent exists evidence.
        expect(signals).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "keeps killed provenance when post-KILL unknown recovers to ESRCH",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        // Members persist through the term window (exists to its deadline),
        // then the kill window sees unknown, unknown, gone — provenance is
        // killed, never empty or terminated.
        const group = scriptedGroup(
          [...Array.from({ length: 41 }, () => "exists" as const), "unknown", "unknown", "gone"],
          10,
        );
        const result = yield* run({
          command: "exec sleep 1",
          timings: { settleMs: 1 },
          deps: group.deps,
        });
        track(t, result);
        expect(result).toMatchObject({
          status: "unproven",
          exitCode: 0,
          group: "killed",
          failure: null,
        });
        expect(group.signals).toEqual(["SIGTERM", "SIGKILL"]);
        expect(group.probes()).toBe(44);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "resumes probe-only recovery after interruption without regaining signal authority",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const pidPath = NodePath.join(t.dir, "leader.pid");
        // Unknown fills the term window. Interrupting mid-recovery lets
        // release resume the same stored deadline — no repeat TERM, no KILL,
        // and probing bounded by the window that was already open.
        const group = scriptedGroup(["exists", "unknown"], 10);
        const fiber = yield* run({
          command: `echo $$ > "$PIDF"; exec sleep 1`,
          env: { PIDF: pidPath },
          timings: { settleMs: 1 },
          deps: group.deps,
        }).pipe(Effect.forkScoped);
        const pgid = yield* waitForPid(pidPath);
        if (validId(pgid)) t.pgids.push(pgid);
        expect(yield* waitUntil(() => group.probes() >= 3)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(group.signals).toEqual(["SIGTERM"]);
        expect(group.probes()).toBeGreaterThanOrEqual(3);
        expect(group.probes()).toBeLessThanOrEqual(41);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "resumes the interrupted term phase without repeating its signal",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const pidPath = NodePath.join(t.dir, "leader.pid");
        // Interruption after TERM ok but before the window finishes: release
        // resumes the same term phase — a second TERM or a fresh settle would
        // add ops the script cannot produce.
        const group = scriptedGroup(["exists", "unknown", "gone"], 10);
        const fiber = yield* run({
          command: `echo $$ > "$PIDF"; exec sleep 1`,
          env: { PIDF: pidPath },
          timings: { settleMs: 1 },
          deps: group.deps,
        }).pipe(Effect.forkScoped);
        const pgid = yield* waitForPid(pidPath);
        if (validId(pgid)) t.pgids.push(pgid);
        expect(yield* waitUntil(() => group.signals.length === 1)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(group.signals).toEqual(["SIGTERM"]);
        expect(group.probes()).toBe(3);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "runs zero operations on release once gone is latched after intervention",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const pidPath = NodePath.join(t.dir, "leader.pid");
        // Whether the interrupt lands before or after the gone observation,
        // the attempt ends with exactly two probes — a re-entered pass sees
        // knownGone and admits nothing more.
        const group = scriptedGroup(["exists", "gone"], 10);
        const fiber = yield* run({
          command: `echo $$ > "$PIDF"; exec sleep 1`,
          env: { PIDF: pidPath },
          timings: { settleMs: 1 },
          deps: group.deps,
        }).pipe(Effect.forkScoped);
        const pgid = yield* waitForPid(pidPath);
        if (validId(pgid)) t.pgids.push(pgid);
        expect(yield* waitUntil(() => group.signals.length === 1)).toBe(true);
        yield* Fiber.interrupt(fiber);
        expect(group.signals).toEqual(["SIGTERM"]);
        expect(group.probes()).toBe(2);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "keeps a pre-intervention unknown terminal across release reentry",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const pidPath = NodePath.join(t.dir, "leader.pid");
        // An unknown before any intervention is an immediate failure — the
        // release's pass must not reinterpret it as a recovery attempt. The
        // 50ms settle window admits exactly the first scripted probe.
        const group = scriptedGroup(["unknown"], 60);
        const fiber = yield* run({
          command: `echo $$ > "$PIDF"; exec sleep 3`,
          env: { PIDF: pidPath },
          timings: { settleMs: 50 },
          deps: group.deps,
        }).pipe(Effect.forkScoped);
        const pgid = yield* waitForPid(pidPath);
        if (validId(pgid)) t.pgids.push(pgid);
        yield* Fiber.interrupt(fiber);
        expect(group.signals).toEqual([]);
        expect(group.probes()).toBe(1);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("keeps a denied signal terminal across release reentry", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const pidPath = NodePath.join(t.dir, "leader.pid");
      // A denied TERM latches forbidden before any intervention — release
      // neither retries the signal nor escalates to KILL. The 50ms settle
      // window admits exactly the first scripted probe.
      const group = scriptedGroup(["exists"], 60);
      let denied = 0;
      const fiber = yield* run({
        command: `echo $$ > "$PIDF"; exec sleep 3`,
        env: { PIDF: pidPath },
        timings: { settleMs: 50 },
        deps: {
          ...group.deps,
          signalGroup: (_pgid, signal) => {
            group.signals.push(signal);
            denied += 1;
            return "denied";
          },
        },
      }).pipe(Effect.forkScoped);
      const pgid = yield* waitForPid(pidPath);
      if (validId(pgid)) t.pgids.push(pgid);
      yield* Fiber.interrupt(fiber);
      expect(group.signals).toEqual(["SIGTERM"]);
      expect(denied).toBe(1);
      expect(group.probes()).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("times out cleanup when the group never empties", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const signals: Array<"SIGTERM" | "SIGKILL"> = [];
      const result = yield* run({
        command: "exec sleep 1",
        deps: {
          probeGroup: () => "exists",
          signalGroup: (_pgid, signal) => {
            signals.push(signal);
            return "ok";
          },
        },
      });
      track(t, result);
      expect(result).toMatchObject({
        status: "unproven",
        group: "unknown",
        failure: "cleanup-timeout",
      });
      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "bounds the EOF wait when a group escapee keeps an inherited pipe",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const holderPidPath = NodePath.join(t.dir, "holder.pid");
        const started = performance.now();
        const result = yield* run({
          // stdio [ignore,1,2] keeps the inherited pipes inside the detached
          // grandchild, so EOF never arrives even though the group reads empty.
          command: escapeeLauncher('["ignore",1,2]', "HOLDER_FILE"),
          env: { LAUNCH_EXE: process.execPath, HOLDER_FILE: holderPidPath },
          timings: { eofMs: 300 },
        });
        const elapsed = performance.now() - started;
        track(t, result);
        const holderPid = yield* waitForPid(holderPidPath);
        if (validId(holderPid)) t.pids.push(holderPid);
        expect(holderPid).toBeGreaterThan(0);
        expect(result).toMatchObject({
          status: "unproven",
          exitCode: 0,
          group: "empty",
          stdout: null,
          stderr: null,
          failure: null,
        });
        expect(elapsed).toBeLessThan(10_000);
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "passes a group escapee that dropped its pipes (documented blind spot)",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const escapeePidPath = NodePath.join(t.dir, "escapee.pid");
        const result = yield* run({
          command: escapeeLauncher('["ignore","ignore","ignore"]', "ESC_FILE"),
          env: { LAUNCH_EXE: process.execPath, ESC_FILE: escapeePidPath },
        });
        track(t, result);
        const escapeePid = yield* waitForPid(escapeePidPath);
        if (validId(escapeePid)) t.pids.push(escapeePid);
        expect(escapeePid).toBeGreaterThan(0);
        // Group-empty + EOF + exit 0 cannot see a group-escaped, pipe-dropped
        // descendant — that is the executor's documented limitation.
        expect(result).toMatchObject({
          status: "passed",
          exitCode: 0,
          group: "empty",
        });
      }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("hashes raw binary output bytes without keeping the text", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const payload = Uint8Array.from([0x00, 0xff, 0x10, 0x41, 0x42, 0x43]);
      const result = yield* run({ command: "printf '\\000\\377\\020ABC'" });
      track(t, result);
      expect(result.status).toBe("passed");
      expect(result.stdout).toEqual({ bytes: 6, sha256: sha256Of(payload) });
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("digests streams larger than one pipe buffer", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const expected = sha256Of(new Uint8Array(65_536).fill(0x78));
      const result = yield* run({ command: "head -c 65536 /dev/zero | tr '\\0' x" });
      track(t, result);
      expect(result.status).toBe("passed");
      expect(result.stdout).toEqual({ bytes: 65_536, sha256: expected });
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)("reports a signalled leader as unproven instead of passing", () =>
    Effect.gen(function* () {
      const t = yield* tracked;
      const result = yield* run({ command: "kill -TERM $$" });
      track(t, result);
      expect(result).toMatchObject({
        status: "unproven",
        exitCode: null,
        exitedBy: "signal",
        exitSignal: "SIGTERM",
        group: "empty",
        failure: "signaled",
      });
    }).pipe(Effect.scoped),
  );

  it.live.skipIf(windowsHost)(
    "keeps a secret marker out of results and logs across failure edges",
    () =>
      Effect.gen(function* () {
        const t = yield* tracked;
        const marker = "T3_MARKER_4f2a9c";
        const logs: string[] = [];
        const capture = Logger.make(({ message }) => {
          logs.push(String(message));
        });
        const captured = Logger.layer([capture], { mergeWithExisting: false });
        const spawnFailed = yield* run({
          shell: NodePath.join(t.dir, "missing-sh"),
          command: `echo ${marker}; true`,
        }).pipe(Effect.provide(captured));
        expect(spawnFailed).toMatchObject({
          status: "unproven",
          exitedBy: "spawn-failed",
          group: "not-started",
          pgid: null,
          failure: "spawn-failed",
        });
        const denied = yield* run({
          command: `echo ${marker}`,
          deps: { probeGroup: () => "unknown" },
        }).pipe(Effect.provide(captured));
        track(t, denied);
        expect(denied.status).toBe("unproven");
        const passed = yield* run({ command: `echo ${marker}` }).pipe(Effect.provide(captured));
        track(t, passed);
        expect(passed.status).toBe("passed");
        // Output and command text never surface: only digests and fixed codes.
        for (const result of [spawnFailed, denied, passed]) {
          expect(JSON.stringify(result)).not.toContain(marker);
        }
        expect(logs.join("\n")).not.toContain(marker);
      }).pipe(Effect.scoped),
  );
});
