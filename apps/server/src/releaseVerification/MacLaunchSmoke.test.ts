// @effect-diagnostics nodeBuiltinImport:off - The fake launcher writes into real folders, and a real
// loopback server stands in for the app's backend so the HTTP check runs for real.
import { describe, expect, it, vi } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";
import {
  EMPTY_PROOF,
  LAUNCH_UNCONFIRMED_MARKER,
  type LaunchSmokeTiming,
  buildLaunchEnvironment,
  launchSmokeWithTiming,
  missingProof,
  ownedTree,
  parseProcessList,
  proofFromTrace,
  reduceProof,
  startedAtMs,
  validateBackendOrigin,
} from "./MacLaunchSmoke.ts";

const ORIGIN = "http://127.0.0.1:43123/";

const backendReady = (url: string) => ({
  name: "desktop.window.handleBackendReady",
  events: [{ name: "backend ready", attributes: { source: "http", url } }],
});
const windowCreated = {
  name: "desktop.window.createMain",
  events: [{ name: "main window created", attributes: {} }],
};
const clientSettings = (tag: string) => ({
  name: "desktop.ipc.clientSettings.get",
  exit: { _tag: tag },
  events: [],
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const ndjson = (...records: ReadonlyArray<unknown>) =>
  `${records.map((record) => encodeJson(record)).join("\n")}\n`;

const proofOf = (...records: ReadonlyArray<unknown>) => records.reduce(reduceProof, EMPTY_PROOF);

describe("origin and proof", () => {
  it("accepts only a plain loopback http origin with a port", () => {
    expect(validateBackendOrigin(ORIGIN)).toBe("http://127.0.0.1:43123");
    expect(validateBackendOrigin("http://[::1]:4000/")).toBe("http://[::1]:4000");
    const rejected = [
      "https://127.0.0.1:43123/",
      "http://127.0.0.1/",
      "http://localhost:43123/",
      "http://0.0.0.0:43123/",
      "http://192.168.1.5:43123/",
      "http://evil.example:43123/",
      "http://127.0.0.1:43123@evil.example/",
      "http://user:pass@127.0.0.1:43123/",
      "http://127.0.0.1:43123/?token=abc",
      "http://127.0.0.1:43123/#token=abc",
      "http://127.0.0.1:43123/app",
      "http://127.0.0.1:43123\\@evil.example/",
      "not a url",
      "",
      undefined,
      null,
      42,
    ];
    for (const value of rejected) {
      expect(validateBackendOrigin(value), String(value)).toBeNull();
    }
  });

  it("needs backend ready, main window and a successful clientSettings span", () => {
    const all = proofOf(backendReady(ORIGIN), windowCreated, clientSettings("Success"));
    expect(missingProof(all)).toEqual([]);
    expect(all.origin).toBe("http://127.0.0.1:43123");
    // A backend that merely answers HTTP is not enough: every signal is required.
    expect(missingProof(proofOf(backendReady(ORIGIN), windowCreated))).toEqual([
      "clientSettings IPC success",
    ]);
    expect(missingProof(proofOf(windowCreated, clientSettings("Success")))).toEqual([
      "backend ready",
    ]);
    expect(missingProof(proofOf(backendReady(ORIGIN), clientSettings("Success")))).toEqual([
      "main window created",
    ]);
  });

  it("does not count failed, nested or unrelated spans as the clientSettings proof", () => {
    const notProof = [
      clientSettings("Failure"),
      clientSettings("Interrupted"),
      { name: "desktop.ipc.clientSettings.set", exit: { _tag: "Success" } },
      { name: "desktop.ipc.clientSettings.get", events: [] },
      {
        name: "wrapper",
        events: [{ name: "desktop.ipc.clientSettings.get", exit: { _tag: "Success" } }],
      },
      "desktop.ipc.clientSettings.get",
      null,
    ];
    for (const record of notProof) {
      const proof = proofOf(backendReady(ORIGIN), windowCreated, record);
      expect(proof.settings, encodeJson(record)).toBe(false);
    }
  });

  it("ignores a backend ready with a hostile URL and keeps the newest valid origin", () => {
    expect(proofOf(backendReady("http://evil.example:80/")).origin).toBeNull();
    expect(
      proofOf(backendReady(ORIGIN), backendReady("http://127.0.0.1:43123/?token=SECRET")).origin,
    ).toBe("http://127.0.0.1:43123");
    expect(proofOf(backendReady(ORIGIN), backendReady("http://127.0.0.1:50000/")).origin).toBe(
      "http://127.0.0.1:50000",
    );
  });

  it("reads whole trace lines only and skips junk", () => {
    const complete = ndjson(backendReady(ORIGIN), windowCreated, clientSettings("Success"));
    expect(missingProof(proofFromTrace(`not json\n\n${complete}`))).toEqual([]);
    // The last line is not trusted until its newline arrives.
    expect(proofFromTrace(complete.slice(0, -1)).settings).toBe(false);
  });

  it("redirects only the app's own data, leaving HOME and the keychain native", () => {
    // No HOME on purpose: a fake HOME blocked the app on a keychain prompt, and the keychain and
    // other per-user OS state are shared with the real user, so this is not a sandbox.
    expect(buildLaunchEnvironment("/private/tmp/t3v-x")).toEqual({
      TMPDIR: "/private/tmp/t3v-x/tmp",
      T3CODE_HOME: "/private/tmp/t3v-x/t3-home",
      T3CODE_DESKTOP_USER_DATA_DIR: "/private/tmp/t3v-x/electron-user-data",
      T3CODE_DISABLE_AUTO_UPDATE: "true",
      ELECTRON_ENABLE_LOGGING: "1",
      VITE_DEV_SERVER_URL: "",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "en_US.UTF-8",
    });
  });
});

describe("process identity", () => {
  const started = "Thu Oct  2 12:00:00 2026";

  it("parses ps output and follows only live descendants of the identified root", () => {
    const entries = parseProcessList(
      [
        `  100     1 Ss   ${started}`,
        `  200   100 S    ${started}`,
        `  300   200 S    ${started}`,
        `  400     1 S    ${started}`,
        `  500   100 Z    ${started}`,
        "garbage",
      ].join("\n"),
    );
    expect(entries).toHaveLength(5);
    expect(entries[0]).toEqual({ pid: 100, ppid: 1, stat: "Ss", startedAt: started });
    const pids = (owned: ReadonlyMap<number, string>) =>
      ownedTree(owned, entries).map((entry) => entry.pid);
    expect(pids(new Map([[100, started]]))).toEqual([100, 200, 300]);
    // The same pid with another start time is another process, and so is everything below it.
    expect(pids(new Map([[100, "Fri Oct  3 12:00:00 2026"]]))).toEqual([]);
    expect(pids(new Map([[999, started]]))).toEqual([]);
    expect(pids(new Map([[500, started]]))).toEqual([]);
  });

  it("never treats launchd as owned, even if it ended up in the owned map", () => {
    const entries = parseProcessList(`    1     0 Ss   ${started}\n  100     1 S    ${started}`);
    expect(ownedTree(new Map([[1, started]]), entries)).toEqual([]);
  });

  it("keeps following an orphaned owned process after the root is gone", () => {
    const entries = parseProcessList(
      [
        // 200 was seen below the root, which has since exited; it now hangs off launchd.
        `  200     1 S    ${started}`,
        `  300   200 S    ${started}`,
        `  310   300 S    ${started}`,
        // Not below any owned process, even though it also hangs off launchd.
        `  400     1 S    ${started}`,
        `  410   400 S    ${started}`,
      ].join("\n"),
    );
    const owned = new Map([
      [100, started],
      [200, started],
    ]);
    expect(ownedTree(owned, entries).map((entry) => entry.pid)).toEqual([200, 300, 310]);
  });

  it("reads an lstart as UTC milliseconds", () => {
    expect(startedAtMs(started)).toBe(Date.UTC(2026, 9, 2, 12, 0, 0));
    expect(startedAtMs("garbage")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* launchSmoke against a fake launcher (env running osascript), ps and kill   */
/* -------------------------------------------------------------------------- */

/** How the launcher must start: the fake answers `env` only when its arguments begin like this. */
const STRIPPED_LAUNCH = ["-u", "ELECTRON_RUN_AS_NODE", "/usr/bin/osascript"];

const APP = 4300;
const SERVER = 4301;
const CHILD = 4302;
const OTHER = 4999;

const FAST = {
  launchMs: 2_000,
  toolMs: 2_000,
  proofMs: 150,
  httpMs: 400,
  termMs: 100,
  killMs: 100,
  pollMs: 5,
} satisfies LaunchSmokeTiming;

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `ps -o lstart` text under TZ=UTC: `Thu Oct  2 12:00:00 2026`, with the day padded to two. */
const lstart = (ms: number) => {
  const p = DateTime.toPartsUtc(DateTime.makeUnsafe(ms));
  const two = (value: number) => String(value).padStart(2, "0");
  const clock = `${two(p.hour)}:${two(p.minute)}:${two(p.second)}`;
  const day = String(p.day).padStart(2, " ");
  return `${WEEKDAYS[p.weekDay] ?? ""} ${MONTH_NAMES[p.month - 1] ?? ""} ${day} ${clock} ${p.year}`;
};

interface WorldOptions {
  /** What the launcher does. Everything but "ok" and the failures below also starts the app. */
  readonly launch?: "ok" | "launch-error" | "prepare-error" | "spawn-error" | "garbage" | "timeout";
  readonly bundlePath?: string;
  readonly trace?: "full" | "no-settings";
  readonly appStartedMsAgo?: number;
  /** The app is gone from this `ps` call on; its server stays behind, reparented to launchd. */
  readonly rootExitsAtPs?: number;
  /** The orphaned server starts a child just before the third `ps` call. */
  readonly lateChild?: boolean;
  /** The server ignores SIGTERM and SIGKILL. */
  readonly stubborn?: boolean;
  /** Runs once the app has been started, before the launcher answers. */
  readonly onLaunch?: Effect.Effect<void>;
}

const makeWorld = (runDir: string, origin: string, options: WorldOptions) => {
  const appPath = NodePath.join(runDir, "launch", "OOP.app");
  const procs = new Map([
    [OTHER, { ppid: 1, stat: "Ss", startedAt: lstart(Date.UTC(2024, 0, 1)) }],
  ]);
  const calls: Array<{ name: string; args: ReadonlyArray<string> }> = [];
  // This process's own ELECTRON_RUN_AS_NODE as each tool was started.
  const ambient: Array<string | undefined> = [];
  const signals: Array<{ name: string; pids: ReadonlyArray<number> }> = [];
  let psCalls = 0;

  const output = (code: number, stdout = ""): ProcessRunner.ProcessRunOutput => ({
    stdout,
    stderr: "",
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });

  const startApp = Effect.gen(function* () {
    const startedAt = lstart((yield* Clock.currentTimeMillis) - (options.appStartedMsAgo ?? 0));
    procs.set(APP, { ppid: 1, stat: "S", startedAt });
    procs.set(SERVER, { ppid: APP, stat: "S", startedAt });
    const records = [
      backendReady(origin),
      windowCreated,
      ...(options.trace === "no-settings" ? [] : [clientSettings("Success")]),
    ];
    const logs = NodePath.join(runDir, "t3-home", "userdata", "logs");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(logs, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(logs, "desktop.trace.ndjson"), ndjson(...records));
    });
  });

  const launcher = (
    args: ReadonlyArray<string>,
  ): Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError> => {
    const mode = options.launch ?? "ok";
    if (mode === "spawn-error") {
      return Effect.fail(
        new ProcessRunner.ProcessSpawnError({
          command: "env",
          argumentCount: args.length,
          cause: new Error("ENOENT"),
        }),
      );
    }
    if (mode === "launch-error") {
      const reply = { launchError: "The application cannot be opened." };
      return Effect.succeed(output(0, encodeJson(reply)));
    }
    if (mode === "prepare-error") {
      const reply = { prepareError: "missing AppKit constant" };
      return Effect.succeed(output(0, encodeJson(reply)));
    }
    const answer =
      mode === "garbage"
        ? output(0, "not json")
        : mode === "timeout"
          ? { ...output(0), code: null, timedOut: true }
          : output(0, encodeJson({ pid: APP, bundlePath: options.bundlePath ?? appPath }));
    return startApp.pipe(Effect.andThen(options.onLaunch ?? Effect.void), Effect.as(answer));
  };

  const ps = () => {
    psCalls += 1;
    const server = procs.get(SERVER);
    if (options.rootExitsAtPs !== undefined && psCalls >= options.rootExitsAtPs) {
      procs.delete(APP);
      if (server !== undefined) procs.set(SERVER, { ...server, ppid: 1 });
    }
    if (options.lateChild && psCalls === 3 && server !== undefined) {
      procs.set(CHILD, { ppid: SERVER, stat: "S", startedAt: server.startedAt });
    }
    const lines = [...procs].map(([pid, p]) => `${pid} ${p.ppid} ${p.stat} ${p.startedAt}`);
    return output(0, lines.join("\n"));
  };

  const kill = (args: ReadonlyArray<string>) => {
    const [, name = "", ...rest] = args;
    const pids = rest.map(Number);
    signals.push({ name, pids });
    for (const pid of pids) {
      if (!(options.stubborn && pid === SERVER)) procs.delete(pid);
    }
    return output(0);
  };

  const runner: ProcessRunner.ProcessRunner["Service"] = {
    run: (input) => {
      const name = NodePath.basename(input.command);
      calls.push({ name, args: input.args });
      ambient.push(process.env.ELECTRON_RUN_AS_NODE);
      if (input.command === "/usr/bin/env") {
        // A launcher that does not strip the variable, or runs another tool, finds nothing here.
        const stripped = STRIPPED_LAUNCH.every((arg, index) => input.args[index] === arg);
        return stripped ? launcher(input.args) : Effect.succeed(output(127));
      }
      if (name === "ps") return Effect.succeed(ps());
      if (name === "kill") return Effect.succeed(kill(input.args));
      return Effect.succeed(output(127));
    },
  };

  return {
    runner,
    calls,
    ambient,
    signals,
    alive: () => [...procs.keys()].sort((a, b) => a - b),
  };
};

const makeRunDir = Effect.acquireRelease(
  Effect.promise(async () => {
    // Short and real: the helper refuses a runDir over 54 bytes, and /tmp is a symlink on macOS.
    const dir = await NodeFSP.realpath(await NodeFSP.mkdtemp("/tmp/t3v-"));
    await NodeFSP.mkdir(NodePath.join(dir, "launch", "OOP.app"), { recursive: true });
    return dir;
  }),
  (dir) => Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true })),
);

/** A loopback server for the app's backend; "down" is a port that refuses connections. */
const makeBackend = (status: number | "down") =>
  Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<{ server: NodeHttp.Server; origin: string; hits: string[] }>((resolve) => {
          const hits: string[] = [];
          const server = NodeHttp.createServer((request, response) => {
            hits.push(request.url ?? "");
            response.statusCode = status === "down" ? 200 : status;
            response.end("ok");
          });
          server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as NodeNet.AddressInfo;
            if (status === "down") server.close();
            resolve({ server, hits, origin: `http://127.0.0.1:${port}/` });
          });
        }),
    ),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );

const scenario = (options: WorldOptions & { readonly http?: number | "down" } = {}) =>
  Effect.gen(function* () {
    const runDir = yield* makeRunDir;
    const server = yield* makeBackend(options.http ?? 200);
    const world = makeWorld(runDir, server.origin, options);
    const mayRun: boolean[] = [];
    const setMayRun = (value: boolean) => Effect.sync(() => void mayRun.push(value));
    const runWith = (timing: LaunchSmokeTiming) =>
      launchSmokeWithTiming(runDir, setMayRun, timing).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, world.runner),
      );
    const markerExists = Effect.promise(() =>
      NodeFSP.access(NodePath.join(runDir, LAUNCH_UNCONFIRMED_MARKER)).then(
        () => true,
        () => false,
      ),
    );
    return { runDir, server, world, mayRun, setMayRun, runWith, run: runWith(FAST), markerExists };
  });

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("launchSmoke", () => {
  it.live(
    "passes on all three signals, HTTP 200 and a running app, then stops what it started",
    () =>
      Effect.gen(function* () {
        const s = yield* scenario();
        const result = yield* s.run;

        expect(result).toMatchObject({ status: "passed", cleanupSucceeded: true });
        expect(result.tail).toContain("trace: all three signals seen");
        expect(s.server.hits).toEqual(["/"]);
        // Only the launched app and the server seen below it were signalled, never the bystander.
        expect(s.world.signals).toEqual([{ name: "TERM", pids: [APP, SERVER] }]);
        expect(s.world.alive()).toEqual([OTHER]);
        expect(s.mayRun).toEqual([true, false]);
        expect(yield* s.markerExists).toBe(false);

        // `env -u ELECTRON_RUN_AS_NODE /usr/bin/osascript -l JavaScript -e <script> <app> <env>`.
        const launch = s.world.calls.find((call) => call.name === "env");
        expect(launch?.args.slice(0, 6)).toEqual([...STRIPPED_LAUNCH, "-l", "JavaScript", "-e"]);
        expect(launch?.args).toHaveLength(9);
        expect(launch?.args[7]).toBe(NodePath.join(s.runDir, "launch", "OOP.app"));
        expect(decodeJson(launch?.args[8] ?? "{}")).toEqual(buildLaunchEnvironment(s.runDir));
        const folders = yield* Effect.promise(() => NodeFSP.readdir(s.runDir));
        expect(folders.sort()).toEqual(["electron-user-data", "launch", "t3-home", "tmp"]);
      }).pipe(Effect.scoped),
  );

  it.live("strips ELECTRON_RUN_AS_NODE from the launcher only, never from this process", () =>
    Effect.gen(function* () {
      yield* Effect.acquireRelease(
        Effect.sync(() => void vi.stubEnv("ELECTRON_RUN_AS_NODE", "1")),
        () => Effect.sync(() => void vi.unstubAllEnvs()),
      );
      const s = yield* scenario();
      const result = yield* s.run;

      expect(result).toMatchObject({ status: "passed", cleanupSucceeded: true });
      const launchers = s.world.calls.filter((call) => call.name === "env");
      expect(launchers).toHaveLength(1);
      expect(launchers[0]?.args.slice(0, 3)).toEqual(STRIPPED_LAUNCH);
      // Every tool started, the launcher included, while this process still had the variable, and
      // it still has it: the strip is the launcher's own `-u`, never a change to the environment.
      expect(s.world.calls.length).toBeGreaterThan(1);
      expect(s.world.ambient).toEqual(s.world.calls.map(() => "1"));
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe("1");
    }).pipe(Effect.scoped),
  );

  it.live("is not a pass without the clientSettings proof and never contacts the backend", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ trace: "no-settings" });
      const result = yield* s.run;

      expect(result).toMatchObject({ status: "timed-out", cleanupSucceeded: true });
      expect(result.detail).toContain("clientSettings IPC success");
      expect(s.server.hits).toEqual([]);
      expect(s.world.alive()).toEqual([OTHER]);
    }).pipe(Effect.scoped),
  );

  it.live("fails when the backend answers 503 or refuses the connection, after cleaning up", () =>
    Effect.gen(function* () {
      for (const http of [503, "down"] as const) {
        const s = yield* scenario({ http });
        const result = yield* s.run;
        expect(result, String(http)).toMatchObject({ status: "failed", cleanupSucceeded: true });
        expect(s.world.alive(), String(http)).toEqual([OTHER]);
        expect(s.mayRun, String(http)).toEqual([true, false]);
      }
    }).pipe(Effect.scoped),
  );

  it.live("stops a server that outlived the app, because it was seen below the app", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ rootExitsAtPs: 2 });
      const result = yield* s.run;

      expect(result).toMatchObject({ status: "failed", cleanupSucceeded: true });
      expect(result.detail).toContain("exited");
      expect(s.world.signals).toEqual([{ name: "TERM", pids: [SERVER] }]);
      expect(s.world.alive()).toEqual([OTHER]);
    }).pipe(Effect.scoped),
  );

  it.live("also stops a child the orphaned server starts after the app has exited", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ rootExitsAtPs: 2, lateChild: true });
      const result = yield* s.run;

      expect(result).toMatchObject({ status: "failed", cleanupSucceeded: true });
      expect(s.world.signals).toEqual([{ name: "TERM", pids: [SERVER, CHILD] }]);
      expect(s.world.alive()).toEqual([OTHER]);
      expect(s.mayRun).toEqual([true, false]);
    }).pipe(Effect.scoped),
  );

  it.live("keeps the folder when the app is already gone at the first listing", () =>
    Effect.gen(function* () {
      // Its server may be orphaned, but it was never seen, so it is neither known nor signalled.
      const s = yield* scenario({ rootExitsAtPs: 1 });
      const result = yield* s.run;

      expect(result).toMatchObject({ status: "failed", cleanupSucceeded: false });
      expect(result.detail).toContain("not observed");
      expect(s.world.signals).toEqual([]);
      expect(s.world.alive()).toEqual([SERVER, OTHER]);
      expect(s.mayRun).toEqual([true]);
      expect(yield* s.markerExists).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("does not pass when an owned process survives SIGKILL, and keeps the folder", () =>
    Effect.gen(function* () {
      const s = yield* scenario({ stubborn: true });
      const result = yield* s.run;

      expect(result).toMatchObject({ status: "not-run", cleanupSucceeded: false });
      expect(result.detail).toContain("Cleanup not confirmed");
      expect(s.world.signals).toEqual([
        { name: "TERM", pids: [APP, SERVER] },
        { name: "KILL", pids: [SERVER] },
      ]);
      expect(s.world.alive()).toEqual([SERVER, OTHER]);
      expect(s.mayRun).toEqual([true]);
      expect(yield* s.markerExists).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.live("stops the app when interrupted while waiting for the proof", () =>
    Effect.gen(function* () {
      const launched = yield* Deferred.make<void>();
      const s = yield* scenario({
        trace: "no-settings",
        onLaunch: Deferred.succeed(launched, undefined).pipe(Effect.asVoid),
      });
      const fiber = yield* s.runWith({ ...FAST, proofMs: 30_000 }).pipe(Effect.forkChild);
      yield* Deferred.await(launched);
      yield* Fiber.interrupt(fiber);

      expect(s.world.alive()).toEqual([OTHER]);
      expect(s.mayRun).toEqual([true, false]);
      expect(yield* s.markerExists).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("frees the folder only when no launch happened", () =>
    Effect.gen(function* () {
      const never = [
        ["launch-error", "failed"],
        ["prepare-error", "not-run"],
        // `env` itself cannot be started, so the launcher never ran.
        ["spawn-error", "not-run"],
      ] as const;
      for (const [launch, status] of never) {
        const s = yield* scenario({ launch });
        const result = yield* s.run;
        expect(result, launch).toMatchObject({ status, cleanupSucceeded: true });
        expect(s.mayRun, launch).toEqual([true, false]);
        expect(yield* s.markerExists, launch).toBe(false);
        expect(s.world.signals, launch).toEqual([]);
      }
      // The launcher said nothing usable: the app may be running, but nothing identifies it,
      // so nothing is signalled and the folder is kept.
      for (const launch of ["garbage", "timeout"] as const) {
        const s = yield* scenario({ launch });
        const result = yield* s.run;
        expect(result, launch).toMatchObject({ status: "timed-out", cleanupSucceeded: false });
        expect(s.mayRun, launch).toEqual([true]);
        expect(yield* s.markerExists, launch).toBe(true);
        expect(s.world.signals, launch).toEqual([]);
        expect(s.world.alive(), launch).toEqual([APP, SERVER, OTHER]);
      }
    }).pipe(Effect.scoped),
  );

  it.live("leaves an app alone when it is not the private copy or predates the request", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<WorldOptions> = [
        { bundlePath: "/Applications/OOP.app" },
        { appStartedMsAgo: 60_000 },
      ];
      for (const options of cases) {
        const s = yield* scenario(options);
        const result = yield* s.run;
        const label = encodeJson(options);
        // An identity anomaly, not an observed product failure: unproven, never "failed".
        expect(result, label).toMatchObject({ status: "not-run", cleanupSucceeded: false });
        expect(s.world.signals, label).toEqual([]);
        expect(s.mayRun, label).toEqual([true]);
        expect(yield* s.markerExists, label).toBe(true);
      }
    }).pipe(Effect.scoped),
  );

  it.live("refuses a too-long runDir and a reused profile without launching", () =>
    Effect.gen(function* () {
      const s = yield* scenario();
      const tooLong = NodePath.join("/tmp", "t3v-".padEnd(60, "x"));
      const long = yield* launchSmokeWithTiming(tooLong, s.setMayRun, FAST).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, s.world.runner),
      );
      expect(long).toMatchObject({ status: "not-run", cleanupSucceeded: true });
      expect(long.detail).toContain("54 bytes");

      yield* Effect.promise(() => NodeFSP.mkdir(NodePath.join(s.runDir, "tmp")));
      const reused = yield* s.run;
      expect(reused).toMatchObject({ status: "not-run", cleanupSucceeded: true });
      expect(reused.detail).toContain("refusing to reuse");

      expect(s.world.calls).toEqual([]);
      expect(s.mayRun).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
