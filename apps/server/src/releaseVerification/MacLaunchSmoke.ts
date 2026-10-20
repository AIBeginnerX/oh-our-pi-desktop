// @effect-diagnostics nodeBuiltinImport:off - The profile folders are made without `recursive`
// (EEXIST is the freshness check), the marker is written exclusively, and the trace is read under
// a size bound. FileSystem offers none of that, and the helper's only service is ProcessRunner.
import {
  RELEASE_VERIFICATION_DETAIL_MAX_LENGTH,
  RELEASE_VERIFICATION_TAIL_LINE_MAX_LENGTH,
  RELEASE_VERIFICATION_TAIL_MAX_LINES,
  type ReleaseVerificationCheckStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Startup smoke for a private copy of OoP.app at `<runDir>/launch/OoP.app`, which the caller
 * copies there first. The copy is started through LaunchServices with its app data redirected
 * into `runDir`.
 *
 * A one-shot `osascript -l JavaScript` calls NSWorkspace with NewInstance and prints the new
 * app's pid and bundle path. LaunchServices parents the app to launchd, so it outlives the
 * script. Ownership is then that pid plus its `ps` start time, and every descendant seen below
 * any owned process on a poll, so an orphaned server's later children are still found. Nothing
 * is ever found by name or path, and only a process whose pid and start time match a fresh `ps`
 * listing is signalled. Descendants that were never observed are not known and are not claimed.
 *
 * Passing needs all of: the launched bundle is the private copy; the fresh desktop trace holds
 * `backend ready`, `main window created` and a successful `desktop.ipc.clientSettings.get`;
 * GET / on the logged loopback origin answers 200; and the app is still running afterwards.
 * Anything missing, late or unclear is a non-pass.
 *
 * Caller contract:
 * - `runDir` is absolute, at most {@link LAUNCH_RUN_DIR_MAX_BYTES} bytes (macOS caps Unix socket
 *   paths at 103 bytes, and the app binds sockets under `<runDir>/tmp`), and holds no
 *   `tmp`, `t3-home` or `electron-user-data` yet. Reuse is refused, not trusted.
 * - `setLaunchMayRun(true)` runs after the marker is written and before the launcher. It is set
 *   back to false only when no launch happened or every owned process is confirmed gone. Until
 *   then `<runDir>/{@link LAUNCH_UNCONFIRMED_MARKER}` exists, and `runDir` must not be deleted.
 * - Give the step at least {@link LAUNCH_SMOKE_TIMEOUT}. Cleanup also runs when the effect is
 *   interrupted, so an outer timeout is safe; a shorter one only ends the proof wait early.
 *
 * What is and is not isolated: only the T3 home, the Electron user-data folder and the temp
 * folder are explicit and fresh. HOME is deliberately left alone, so the app keeps the login
 * session's own HOME and uses the user's real keychain (a fake HOME blocked its SecItemAdd on a
 * keychain prompt). The keychain, preferences, caches and every other per-user OS state are shared
 * with the real user, and LaunchServices merges the variables below over the session's own. This
 * is not a sandbox. The server's own ELECTRON_RUN_AS_NODE is dropped from the launcher's
 * environment only (`env -u`), and this process keeps it. A launchd-level ELECTRON_RUN_AS_NODE
 * cannot be removed this way; the app would then not start as an app and the run times out.
 */

const ENV = "/usr/bin/env";
const OSASCRIPT = "/usr/bin/osascript";
const PS = "/bin/ps";
const KILL = "/bin/kill";

const APP_PATH_SEGMENTS = ["launch", "OoP.app"] as const;
const PROFILE_DIRS = ["tmp", "t3-home", "electron-user-data"] as const;
const TRACE_SEGMENTS = ["t3-home", "userdata", "logs", "desktop.trace.ndjson"] as const;

export const LAUNCH_UNCONFIRMED_MARKER = ".launch-unconfirmed";

// Chromium's single-instance socket is <TMPDIR>/org.chromium.Chromium.XXXXXX/SingletonSocket,
// 49 bytes below runDir (TMPDIR is runDir/tmp), and the socket path limit is 103 bytes.
export const LAUNCH_RUN_DIR_MAX_BYTES = 54;

const TRACE_MAX_BYTES = 16 * 1024 * 1024;
const LAUNCHER_OUTPUT_MAX_BYTES = 64 * 1024;
// `ps` start times only have whole seconds, so allow a little slack against the request time.
const START_TIME_SKEW_MS = 2_000;

export interface LaunchSmokeTiming {
  /** The one-shot launcher. */
  readonly launchMs: number;
  /** Each `ps` or `kill` call. */
  readonly toolMs: number;
  /** Waiting for the three trace signals. */
  readonly proofMs: number;
  readonly httpMs: number;
  /** Grace after SIGTERM, then after SIGKILL. */
  readonly termMs: number;
  readonly killMs: number;
  readonly pollMs: number;
}

const DEFAULT_TIMING: LaunchSmokeTiming = {
  launchMs: 30_000,
  toolMs: 5_000,
  proofMs: 60_000,
  httpMs: 5_000,
  termMs: 8_000,
  killMs: 4_000,
  pollMs: 500,
};

/** Every bound a run can spend in sequence: launch, ps, proof, HTTP, ps, then two release stages. */
const worstCaseMs = (t: LaunchSmokeTiming) =>
  t.launchMs +
  t.toolMs +
  (t.proofMs + t.httpMs + t.toolMs) +
  (t.termMs + t.toolMs) +
  (t.killMs + t.toolMs);

/** The least a caller should allow `launchSmoke`: its own bounds in sequence, plus slack. */
export const LAUNCH_SMOKE_TIMEOUT = Duration.millis(worstCaseMs(DEFAULT_TIMING) + 3_000);

export interface LaunchSmokeResult {
  readonly status: Extract<
    ReleaseVerificationCheckStatus,
    "passed" | "failed" | "timed-out" | "not-run"
  >;
  readonly detail: string;
  readonly tail?: ReadonlyArray<string>;
  /** False means an owned process may still run: the caller must keep `runDir`. */
  readonly cleanupSucceeded?: boolean;
}

interface Outcome {
  readonly status: LaunchSmokeResult["status"];
  readonly detail: string;
}

const outcome =
  (status: Outcome["status"]) =>
  (detail: string): Outcome => ({ status, detail });
const passed = outcome("passed");
const failed = outcome("failed");
const timedOut = outcome("timed-out");
const notRun = outcome("not-run");

const clamp = (text: string, maxLength: number) =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

const errnoCode = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : "unknown";

/**
 * The only variables the app is given. They redirect the app's own data into `runDir`. HOME is
 * intentionally absent, so the session's native HOME and keychain stay in effect; see the module
 * comment for what that shares.
 */
export const buildLaunchEnvironment = (runDir: string): Record<string, string> => ({
  TMPDIR: NodePath.join(runDir, "tmp"),
  T3CODE_HOME: NodePath.join(runDir, "t3-home"),
  T3CODE_DESKTOP_USER_DATA_DIR: NodePath.join(runDir, "electron-user-data"),
  T3CODE_DISABLE_AUTO_UPDATE: "true",
  ELECTRON_ENABLE_LOGGING: "1",
  VITE_DEV_SERVER_URL: "",
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  LANG: "en_US.UTF-8",
});

/* -------------------------------------------------------------------------- */
/* Trace proof                                                                 */
/* -------------------------------------------------------------------------- */

export interface LaunchProof {
  /** Newest `backend ready` origin that passed validation. */
  readonly origin: string | null;
  readonly window: boolean;
  readonly settings: boolean;
}

export const EMPTY_PROOF: LaunchProof = { origin: null, window: false, settings: false };

/**
 * Accepts only a plain `http://127.0.0.1:<port>` or `http://[::1]:<port>` origin: an explicit
 * port and no credentials, path, query or fragment. The log is untrusted input, and this is the
 * only thing it can make the check connect to.
 */
export function validateBackendOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const plain = url.href === `${url.origin}/`;
  return url.protocol === "http:" && loopback && url.port !== "" && plain ? url.origin : null;
}

/**
 * Folds one desktop trace record into the proof. `backend ready` and `main window created` are
 * events nested in a span; the IPC proof is a top-level span that must have exited with Success.
 */
export function reduceProof(proof: LaunchProof, record: unknown): LaunchProof {
  if (!Predicate.isObject(record)) return proof;
  let next = proof;
  for (const event of Array.isArray(record.events) ? record.events : []) {
    if (!Predicate.isObject(event)) continue;
    if (event.name === "main window created") next = { ...next, window: true };
    if (event.name === "backend ready") {
      const attributes = Predicate.isObject(event.attributes) ? event.attributes : {};
      const origin = validateBackendOrigin(attributes.url);
      if (origin !== null) next = { ...next, origin };
    }
  }
  const exit = record.exit;
  if (
    record.name === "desktop.ipc.clientSettings.get" &&
    Predicate.isObject(exit) &&
    exit._tag === "Success"
  ) {
    next = { ...next, settings: true };
  }
  return next;
}

const parseJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
};

/** The proof in a whole NDJSON trace. A last line without its newline is not trusted yet. */
export function proofFromTrace(text: string): LaunchProof {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  return complete
    .split("\n")
    .reduce((proof, line) => reduceProof(proof, parseJson(line)), EMPTY_PROOF);
}

export const missingProof = (proof: LaunchProof): string[] => [
  ...(proof.origin === null ? ["backend ready"] : []),
  ...(proof.window ? [] : ["main window created"]),
  ...(proof.settings ? [] : ["clientSettings IPC success"]),
];

/* -------------------------------------------------------------------------- */
/* Process identity                                                            */
/* -------------------------------------------------------------------------- */

export interface ProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly stat: string;
  /** The raw `lstart` text, which is the identity that tells a pid's owner apart from a reuse. */
  readonly startedAt: string;
}

const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Parses `ps -axo pid=,ppid=,stat=,lstart=`. A line that does not parse is skipped. */
export const parseProcessList = (output: string): ProcessEntry[] =>
  output.split("\n").flatMap((line) => {
    const [, pid = "", ppid = "", stat = "", startedAt = ""] = PS_LINE.exec(line) ?? [];
    return startedAt === "" ? [] : [{ pid: Number(pid), ppid: Number(ppid), stat, startedAt }];
  });

/** Epoch milliseconds of an `lstart` read under TZ=UTC, or null when it is not one. */
export function startedAtMs(startedAt: string): number | null {
  const [, month = "", day = "", time = "", year = ""] = startedAt.trim().split(/\s+/);
  const [hours = "", minutes = "", seconds = ""] = time.split(":");
  const ms = Date.UTC(
    Number(year),
    MONTHS.indexOf(month),
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
  return MONTHS.includes(month) && Number.isFinite(ms) ? ms : null;
}

const isDead = (entry: ProcessEntry) => entry.stat.startsWith("Z");

/** Never launchd, never this server, never a zombie. */
const isSignalable = (entry: ProcessEntry) =>
  entry.pid > 1 && entry.pid !== process.pid && !isDead(entry);

/**
 * Every live process that is a captured identity (same pid and start time) or a descendant of
 * one. Seeding from all captured identities, not only the root, keeps an orphaned server's later
 * children in reach after the root is gone. A pid that now has another start time matches
 * nothing, and neither does anything below it.
 */
export function ownedTree(
  owned: ReadonlyMap<number, string>,
  entries: ReadonlyArray<ProcessEntry>,
): ProcessEntry[] {
  const tree = entries.filter(
    (entry) => isSignalable(entry) && owned.get(entry.pid) === entry.startedAt,
  );
  for (const parent of tree) {
    for (const entry of entries) {
      if (entry.ppid === parent.pid && isSignalable(entry) && !tree.includes(entry)) {
        tree.push(entry);
      }
    }
  }
  return tree;
}

/* -------------------------------------------------------------------------- */
/* Tools                                                                       */
/* -------------------------------------------------------------------------- */

type ToolResult =
  | { readonly kind: "exited"; readonly code: number | null; readonly stdout: string }
  | { readonly kind: "timed-out" }
  /** The tool never started, so it cannot have done anything. */
  | { readonly kind: "unstarted" }
  | { readonly kind: "failed" };

/** Runs one fixed tool. Nothing here fails: a tool that cannot run is reported as a result. */
const runTool = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number,
  extra: Pick<ProcessRunner.ProcessRunInput, "env" | "maxOutputBytes"> = {},
) =>
  Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
    runner.run({
      command,
      args,
      timeout: Duration.millis(timeoutMs),
      timeoutBehavior: "timedOutResult",
      ...extra,
    }),
  ).pipe(
    Effect.map((output): ToolResult =>
      output.timedOut
        ? { kind: "timed-out" }
        : { kind: "exited", code: output.code, stdout: output.stdout },
    ),
    Effect.catch((error) =>
      Effect.succeed<ToolResult>({
        kind: error._tag === "ProcessSpawnError" ? "unstarted" : "failed",
      }),
    ),
  );

/** A full process listing, or null when `ps` could not be read. Never a partial one. */
const listProcesses = (t: LaunchSmokeTiming) =>
  runTool(PS, ["-axo", "pid=,ppid=,stat=,lstart="], t.toolMs, {
    env: { TZ: "UTC", LC_ALL: "C" },
  }).pipe(
    Effect.map((result) => {
      if (result.kind !== "exited" || result.code !== 0) return null;
      const entries = parseProcessList(result.stdout);
      return entries.length > 0 ? entries : null;
    }),
  );

/** Runs inside osascript and prints one JSON line. Nothing before the launch call can launch. */
const LAUNCH_SCRIPT = String.raw`
ObjC.import('AppKit');

function run(argv) {
  let appUrl;
  let configuration;
  let options = 0;
  try {
    // The bridge hands these enum constants over as strings ("524288"), so convert with Number and
    // accept only the exact AppKit value: a missing or different constant fails before any launch.
    const expected = {
      NSWorkspaceLaunchNewInstance: 524288,
      NSWorkspaceLaunchWithoutActivation: 512,
      NSWorkspaceLaunchWithoutAddingToRecents: 256,
    };
    for (const name of Object.keys(expected)) {
      const value = Number($[name]);
      if (!Number.isInteger(value) || value <= 0 || value !== expected[name]) {
        throw new Error('missing or unexpected AppKit constant ' + name);
      }
      options |= value;
    }
    const key = ObjC.unwrap($.NSWorkspaceLaunchConfigurationEnvironment);
    if (typeof key !== 'string') throw new Error('missing AppKit constant NSWorkspaceLaunchConfigurationEnvironment');
    const workspace = $.NSWorkspace.sharedWorkspace;
    if (typeof workspace.launchApplicationAtURLOptionsConfigurationError !== 'function') {
      throw new Error('synchronous NSWorkspace launch API unavailable');
    }
    appUrl = $.NSURL.fileURLWithPath(argv[0]);
    configuration = $({ [key]: JSON.parse(argv[1]) });
  } catch (e) {
    return JSON.stringify({ prepareError: String(e) });
  }
  const error = Ref();
  const app = $.NSWorkspace.sharedWorkspace.launchApplicationAtURLOptionsConfigurationError(
    appUrl, options, configuration, error);
  let pid = 0;
  try { pid = Number(app.processIdentifier); } catch (e) {}
  if (!(pid > 0)) {
    // A nil result carries no NSError, so only a real description replaces this fallback.
    let message = 'LaunchServices returned no application';
    try {
      const description = ObjC.unwrap(error[0].localizedDescription);
      if (typeof description === 'string' && description !== '') message = description;
    } catch (e) {}
    return JSON.stringify({ launchError: message });
  }
  let bundlePath = null;
  try { bundlePath = ObjC.unwrap(app.bundleURL.path); } catch (e) {}
  return JSON.stringify({ pid: pid, bundlePath: bundlePath });
}
`;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const decodeLauncherOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ pid: Schema.Int, bundlePath: Schema.NullOr(Schema.String) }),
      Schema.Struct({ launchError: Schema.String }),
      Schema.Struct({ prepareError: Schema.String }),
    ]),
  ),
);

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

interface Run {
  /** The launched app and every process seen below an owned one, as pid to `ps` start time. */
  readonly owned: Map<number, string>;
  root: { readonly pid: number; readonly startedAt: string } | null;
  /** True once no launch happened or every owned process is confirmed gone. */
  confirmed: boolean;
  readonly notes: string[];
}

type SetLaunchMayRun = (value: boolean) => Effect.Effect<void>;

const markerPath = (runDir: string) => NodePath.join(runDir, LAUNCH_UNCONFIRMED_MARKER);

/** Creates the profile folders and the marker. Returns why that was refused, or null. */
const prepareProfile = (runDir: string) =>
  Effect.promise(async (): Promise<string | null> => {
    try {
      for (const name of PROFILE_DIRS) {
        await NodeFSP.mkdir(NodePath.join(runDir, name), { mode: 0o700 });
      }
      await NodeFSP.writeFile(
        markerPath(runDir),
        "OoP launch smoke may still be running. Keep this folder until it is confirmed gone.\n",
        { flag: "wx", mode: 0o600 },
      );
      return null;
    } catch (cause) {
      return errnoCode(cause) === "EEXIST"
        ? "A profile folder or the launch marker already exists; refusing to reuse it."
        : `The profile folders could not be created (${errnoCode(cause)}).`;
    }
  });

/** Drops the marker and tells the caller the folder may be deleted. */
const clear = (runDir: string, setLaunchMayRun: SetLaunchMayRun) =>
  Effect.promise(() => NodeFSP.rm(markerPath(runDir), { force: true }).catch(() => undefined)).pipe(
    Effect.andThen(setLaunchMayRun(false)),
  );

const realPath = (path: string) =>
  Effect.tryPromise(() => NodeFSP.realpath(path)).pipe(Effect.option);

/**
 * Lists processes, adds everything now below an owned process to `run.owned`, and returns the
 * live owned tree and whether the root itself is still the same live process. Null when `ps`
 * could not be read or the root was never identified.
 */
const refresh = (run: Run, t: LaunchSmokeTiming) =>
  listProcesses(t).pipe(
    Effect.map((entries) => {
      const root = run.root;
      if (entries === null || root === null) return null;
      const tree = ownedTree(run.owned, entries);
      for (const entry of tree) run.owned.set(entry.pid, entry.startedAt);
      const isRoot = (entry: ProcessEntry) =>
        entry.pid === root.pid && entry.startedAt === root.startedAt;
      return { tree, alive: tree.some(isRoot) };
    }),
  );

/**
 * Starts the launcher and identifies the app it launched. Returns the outcome when there is
 * nothing to watch, or null once `run.root` is set. Runs uninterruptibly: a launch that was
 * requested is always followed through to an identity or an unconfirmed marker.
 */
const start = (runDir: string, run: Run, setLaunchMayRun: SetLaunchMayRun, t: LaunchSmokeTiming) =>
  Effect.gen(function* () {
    const appPath = NodePath.join(runDir, ...APP_PATH_SEGMENTS);
    // Nothing was created or launched yet, so there is nothing to clean up.
    const refuse = (detail: string) => {
      run.confirmed = true;
      return notRun(detail);
    };
    if (!NodePath.isAbsolute(runDir) || Buffer.byteLength(runDir) > LAUNCH_RUN_DIR_MAX_BYTES) {
      return refuse(
        `runDir must be absolute and at most ${LAUNCH_RUN_DIR_MAX_BYTES} bytes, or the app's socket paths will not fit.`,
      );
    }
    const bundle = yield* realPath(appPath);
    if (Option.isNone(bundle)) return refuse("The private app copy is missing.");
    const problem = yield* prepareProfile(runDir);
    if (problem !== null) return refuse(problem);

    yield* setLaunchMayRun(true);
    // The launch definitely did not happen: the folder may go.
    const neverRan = (result: Outcome) =>
      clear(runDir, setLaunchMayRun).pipe(
        Effect.map(() => {
          run.confirmed = true;
          return result;
        }),
      );

    const requestedAt = yield* Clock.currentTimeMillis;
    // `env -u` drops the server's own ELECTRON_RUN_AS_NODE for this one child: LaunchServices would
    // hand it on to the app, which would then start as plain Node and exit before registering.
    const launchArgs = [
      "-u",
      "ELECTRON_RUN_AS_NODE",
      OSASCRIPT,
      "-l",
      "JavaScript",
      "-e",
      LAUNCH_SCRIPT,
      appPath,
      encodeJson(buildLaunchEnvironment(runDir)),
    ];
    const launcher = yield* runTool(ENV, launchArgs, t.launchMs, {
      maxOutputBytes: LAUNCHER_OUTPUT_MAX_BYTES,
    });
    if (launcher.kind === "unstarted") {
      return yield* neverRan(notRun("The launcher could not be started."));
    }
    const reply =
      launcher.kind === "exited" && launcher.code === 0
        ? decodeLauncherOutput(launcher.stdout.trim())
        : Option.none();
    if (Option.isNone(reply)) {
      const why = launcher.kind === "timed-out" ? "timed out" : "no usable output";
      run.notes.push(`launcher: ${why}`);
      return timedOut("The launcher gave no usable answer, so whether the app started is unknown.");
    }
    const answer = reply.value;
    if ("prepareError" in answer) {
      return yield* neverRan(notRun(`Launcher setup failed: ${answer.prepareError}`));
    }
    if ("launchError" in answer) {
      return yield* neverRan(
        failed(`LaunchServices could not start the app: ${answer.launchError}`),
      );
    }

    // From here the app runs. Until it is identified nothing may be signalled.
    const { pid, bundlePath } = answer;
    if (pid <= 1 || pid === process.pid) {
      return notRun("The launcher reported an unusable process id; nothing was signalled.");
    }
    const reported = bundlePath === null ? Option.none() : yield* realPath(bundlePath);
    if (Option.isNone(reported) || reported.value !== bundle.value) {
      // A LaunchServices or harness anomaly, not an observed product failure: unproven.
      return notRun("LaunchServices started an app that is not the private copy; left untouched.");
    }
    const entries = yield* listProcesses(t);
    if (entries === null) {
      return notRun(
        "The process list was unavailable, so the app was not identified or signalled.",
      );
    }
    const root = entries.find((entry) => entry.pid === pid);
    if (root === undefined || isDead(root)) {
      // Never identified, and anything it started was never seen: unknown, so the folder stays.
      run.notes.push(`launcher: pid ${pid} was not running when first listed`);
      return failed("OoP was not running when first listed; anything it started was not observed.");
    }
    const startedMs = startedAtMs(root.startedAt);
    if (startedMs === null || startedMs < requestedAt - START_TIME_SKEW_MS) {
      // Likewise an identity anomaly, not a product failure: unproven, and left untouched.
      return notRun("The process with the reported id predates this launch; left untouched.");
    }
    run.root = { pid, startedAt: root.startedAt };
    run.owned.set(pid, root.startedAt);
    for (const entry of ownedTree(run.owned, entries)) run.owned.set(entry.pid, entry.startedAt);
    run.notes.push(`launcher: started the private copy as pid ${pid}`);
    return null;
  });

/** The whole trace as text, "" while it is missing or unreadable, null when over the bound. */
const readTrace = (path: string) =>
  Effect.promise(async (): Promise<string | null> => {
    try {
      const handle = await NodeFSP.open(path, "r");
      try {
        const { size } = await handle.stat();
        if (size > TRACE_MAX_BYTES) return null;
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, 0);
        return buffer.toString("utf8", 0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return "";
    }
  });

/**
 * The status of GET <origin>/ without following redirects, or null when nothing answered. The
 * request lives in a scope, so leaving it or being interrupted aborts the request and drops the
 * unread body. The client is built here because the helper's only service is ProcessRunner.
 */
const probeStatus = (origin: string) =>
  Effect.gen(function* () {
    const client = HttpClient.withScope(yield* HttpClient.HttpClient);
    return (yield* client.get(`${origin}/`)).status;
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.provide(FetchHttpClient.layer),
    Effect.catch(() => Effect.succeed(null)),
  );

const checkBackend = (run: Run, origin: string, t: LaunchSmokeTiming) =>
  Effect.gen(function* () {
    const port = new URL(origin).port;
    const answered = yield* probeStatus(origin).pipe(
      Effect.timeoutOption(Duration.millis(t.httpMs)),
    );
    if (Option.isNone(answered)) {
      return timedOut(
        `Backend on loopback port ${port} did not answer within ${t.httpMs / 1000}s.`,
      );
    }
    if (answered.value !== 200) {
      return failed(
        answered.value === null
          ? `Backend on loopback port ${port} could not be reached.`
          : `Backend on loopback port ${port} answered HTTP ${answered.value}.`,
      );
    }
    run.notes.push(`http: GET / answered 200 on loopback port ${port}`);
    // Alive has to be seen after the answer, from a fresh listing.
    const seen = yield* refresh(run, t);
    if (seen === null) {
      return notRun("HTTP 200 was seen but the process list was unavailable afterwards.");
    }
    return seen.alive
      ? passed(
          `Isolated LaunchServices start verified: backend ready, window, clientSettings IPC, HTTP 200 on loopback port ${port}, app still running.`,
        )
      : failed("HTTP 200 was seen but the app was no longer running afterwards.");
  });

/** Waits for the three trace signals, then checks the backend. Interruptible. */
const observe = (run: Run, runDir: string, t: LaunchSmokeTiming) =>
  Effect.gen(function* () {
    const tracePath = NodePath.join(runDir, ...TRACE_SEGMENTS);
    let proof = EMPTY_PROOF;
    const waitForProof = Effect.gen(function* () {
      for (;;) {
        const seen = yield* refresh(run, t);
        if (seen !== null && !seen.alive) {
          return failed("OoP exited before the startup proof was complete.");
        }
        const trace = yield* readTrace(tracePath);
        if (trace === null) {
          return failed("The desktop trace outgrew its size bound before the proof was complete.");
        }
        proof = proofFromTrace(trace);
        if (proof.origin !== null && proof.window && proof.settings) return proof.origin;
        yield* Effect.sleep(Duration.millis(t.pollMs));
      }
    });
    const waited = yield* waitForProof.pipe(Effect.timeoutOption(Duration.millis(t.proofMs)));
    const missing = missingProof(proof).join(", ");
    run.notes.push(missing === "" ? "trace: all three signals seen" : `trace: missing ${missing}`);
    const settled = Option.getOrElse(waited, () =>
      timedOut(`Startup proof incomplete after ${t.proofMs / 1000}s; missing: ${missing}.`),
    );
    return typeof settled === "string" ? yield* checkBackend(run, settled, t) : settled;
  });

/** Owned processes still alive in a fresh listing; null when `ps` could not be read. */
const survivors = (run: Run, t: LaunchSmokeTiming) =>
  refresh(run, t).pipe(Effect.map((seen) => (seen === null ? null : seen.tree)));

/**
 * Signals every owned survivor once, then waits for them to go. Each loop pass takes a fresh
 * listing, so the signal only reaches a pid whose start time still matches. Returns the
 * survivors after the window, or null when the last listing failed.
 */
const converge = (run: Run, name: "TERM" | "KILL", windowMs: number, t: LaunchSmokeTiming) => {
  let signalled = false;
  return Effect.gen(function* () {
    for (;;) {
      const left = yield* survivors(run, t);
      if (left !== null && left.length === 0) return;
      if (left !== null && !signalled) {
        signalled = true;
        run.notes.push(`cleanup: SIG${name} to ${left.length} owned process(es)`);
        yield* runTool(KILL, ["-s", name, ...left.map((entry) => String(entry.pid))], t.toolMs);
      }
      yield* Effect.sleep(Duration.millis(t.pollMs));
    }
  }).pipe(
    Effect.timeoutOption(Duration.millis(windowMs)),
    Effect.flatMap(() => survivors(run, t)),
  );
};

/** SIGTERM, then SIGKILL for what is left. True only if a last listing showed nothing owned. */
const stop = (run: Run, t: LaunchSmokeTiming) =>
  Effect.gen(function* () {
    let left = yield* converge(run, "TERM", t.termMs, t);
    if (left === null || left.length > 0) left = yield* converge(run, "KILL", t.killMs, t);
    return left !== null && left.length === 0;
  });

const SUFFIX = " Cleanup not confirmed; the app may still run, so its folder was kept.";

const finish = (run: Run, result: Outcome): LaunchSmokeResult => {
  const tail = run.notes
    .slice(-RELEASE_VERIFICATION_TAIL_MAX_LINES)
    .map((line) => clamp(line, RELEASE_VERIFICATION_TAIL_LINE_MAX_LENGTH));
  if (run.confirmed) {
    const detail = clamp(result.detail, RELEASE_VERIFICATION_DETAIL_MAX_LENGTH);
    return { status: result.status, detail, tail, cleanupSucceeded: true };
  }
  // A pass cannot outlive uncertain cleanup, and "not-run" claims no observed failure.
  const wasPass = result.status === "passed";
  const base = wasPass ? "Startup proof was observed." : result.detail;
  return {
    status: wasPass ? "not-run" : result.status,
    detail: `${clamp(base, RELEASE_VERIFICATION_DETAIL_MAX_LENGTH - SUFFIX.length)}${SUFFIX}`,
    tail,
    cleanupSucceeded: false,
  };
};

/** `launchSmoke` with its bounds spelled out, so tests do not have to wait for the real ones. */
export const launchSmokeWithTiming = (
  runDir: string,
  setLaunchMayRun: SetLaunchMayRun,
  t: LaunchSmokeTiming,
): Effect.Effect<LaunchSmokeResult, never, ProcessRunner.ProcessRunner> =>
  Effect.suspend(() => {
    const run: Run = { owned: new Map(), root: null, confirmed: false, notes: [] };
    return Effect.acquireUseRelease(
      start(runDir, run, setLaunchMayRun, t),
      (early) => (early === null ? observe(run, runDir, t) : Effect.succeed(early)),
      (early) =>
        early !== null
          ? Effect.void
          : stop(run, t).pipe(
              Effect.flatMap((confirmed) => {
                run.confirmed = confirmed;
                run.notes.push(
                  confirmed ? "cleanup: every owned process is gone" : "cleanup: NOT confirmed",
                );
                return confirmed ? clear(runDir, setLaunchMayRun) : Effect.void;
              }),
            ),
    ).pipe(Effect.map((result) => finish(run, result)));
  });

/**
 * Launches the private copy and reports whether it really started. Cleanup always runs, on
 * interruption too, and is bounded. See the module comment for the caller contract.
 */
export const launchSmoke = (
  runDir: string,
  setLaunchMayRun: (value: boolean) => Effect.Effect<void>,
): Effect.Effect<LaunchSmokeResult, never, ProcessRunner.ProcessRunner> =>
  launchSmokeWithTiming(runDir, setLaunchMayRun, DEFAULT_TIMING);
