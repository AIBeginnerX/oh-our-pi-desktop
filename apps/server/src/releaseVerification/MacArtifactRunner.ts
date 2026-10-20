// @effect-diagnostics nodeBuiltinImport:off - The checks open the DMG with O_NOFOLLOW, fstat the
// open descriptor, lstat every path component, and hash while copying in chunks. FileSystem
// exposes none of the open flags or descriptor-level stats this needs.
import {
  RELEASE_VERIFICATION_DETAIL_MAX_LENGTH,
  RELEASE_VERIFICATION_REQUIRED_CHECKS,
  RELEASE_VERIFICATION_TAIL_LINE_MAX_LENGTH,
  RELEASE_VERIFICATION_TAIL_MAX_LINES,
  ReleaseVerificationArtifactNotFoundError,
  type ReleaseVerificationAttempt,
  type ReleaseVerificationCapability,
  type ReleaseVerificationCheck,
  type ReleaseVerificationCheckId,
} from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { CommandAvailability } from "@t3tools/shared/shell";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";
import {
  LAUNCH_SMOKE_TIMEOUT,
  LAUNCH_UNCONFIRMED_MARKER,
  launchSmoke,
  type LaunchSmokeResult,
} from "./MacLaunchSmoke.ts";

/**
 * Integrity checks for the macOS DMG that sits in a thread's workspace. The
 * server picks the file, copies it into a private folder, and checks the copy,
 * so swapping the original mid-run changes nothing. Every command is a fixed
 * absolute path with a fixed argument list; no user text reaches a shell.
 *
 * The last check starts a private copy of the verified app (see
 * `MacLaunchSmoke`). While a launched app may still be running, its folder is
 * never deleted: the image is unmounted, the folder is kept, and the attempt
 * ends with an error that says so.
 */

const HDIUTIL = "/usr/bin/hdiutil";
const CODESIGN = "/usr/bin/codesign";
const PLUTIL = "/usr/bin/plutil";
// The launch check also needs these: the copy, the launcher (`env` runs `osascript`), process
// listing and signalling, and the folder delete.
const DITTO = "/usr/bin/ditto";
const ENV = "/usr/bin/env";
const OSASCRIPT = "/usr/bin/osascript";
const PS = "/bin/ps";
const KILL = "/bin/kill";
const RM = "/bin/rm";
const REQUIRED_TOOLS = [HDIUTIL, CODESIGN, PLUTIL, DITTO, ENV, OSASCRIPT, PS, KILL, RM] as const;
const CODESIGN_ARGS = ["--verify", "--deep", "--strict", "--verbose=2"] as const;

const APP_NAME = "OoP.app";
const LAUNCH_DIR = "launch";
// One short folder holds everything: macOS caps Unix socket paths at 103 bytes and the launched
// app binds sockets below the folder. `/private/tmp/t3v-<uuid>` is 53 bytes.
const RUN_DIR_PREFIX = "t3v-";
const RUN_DIR_MARKER = ".t3-release-verify";
const MAC_TEMP_DIR = "/tmp";
const RELEASE_FILE_MAX_BYTES = 4 * 1024;
const ARTIFACT_MAX_BYTES = 4 * 1024 ** 3;
const COPY_CHUNK_BYTES = 1024 * 1024;
const TOOL_OUTPUT_MAX_BYTES = 64 * 1024;
const STEP_TIMEOUT_BACKSTOP = Duration.seconds(5);

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const EXECUTABLE_NAME_PATTERN = /^[A-Za-z0-9 ._-]+$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9-]+$/;

const decodeReleaseFile = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.String.check(Schema.isPattern(VERSION_PATTERN)) }),
  ),
);

/** A refusal with a reason fit to show a user; anything else thrown is an I/O failure. */
class Refusal extends Error {}

/** Nothing can be checked without a real temp directory to hold the private copy. */
class TempRootUnavailableError extends Data.TaggedError("TempRootUnavailableError")<{
  readonly message: string;
}> {}

class RunDirCreateError extends Data.TaggedError("RunDirCreateError")<{
  readonly message: string;
}> {}

const errnoCode = (cause: unknown) =>
  Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : null;

const failureDetail = (cause: unknown) =>
  cause instanceof Refusal ? cause.message : `I/O error ${errnoCode(cause) ?? "unknown"}`;

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const clamp = (text: string, maxLength: number) =>
  text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;

/** Whether this server host can run the checks at all. Decided here, never by a client. */
export const macArtifactCapability: Effect.Effect<
  ReleaseVerificationCapability,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const platform = yield* HostProcessPlatform;
  const arch = yield* HostProcessArchitecture;
  if (platform !== "darwin") {
    return { available: false, reason: "Only a macOS server can verify a macOS build." };
  }
  if (arch !== "arm64") {
    return { available: false, reason: "Only an Apple Silicon server can verify this build." };
  }
  const isAvailable = yield* CommandAvailability;
  const missing = yield* Effect.filter(
    REQUIRED_TOOLS,
    (tool) => Effect.map(isAvailable(tool), (available) => !available),
    { concurrency: "unbounded" },
  );
  return missing.length === 0
    ? { available: true, reason: null }
    : { available: false, reason: `${missing.join(", ")} is required and was not found.` };
});

export interface LocatedArtifact {
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly fileName: string;
  readonly appVersion: string;
  readonly dmgPath: string;
  readonly dev: number;
  readonly ino: number;
}

const notFound = (reason: string) => new ReleaseVerificationArtifactNotFoundError({ reason });

const lstatOrNotFound = (path: string, reason: string) =>
  Effect.tryPromise({ try: () => NodeFSP.lstat(path), catch: () => notFound(reason) });

/**
 * Finds the one DMG the server will check: `release/macos/OoP-<version>-arm64.dmg`
 * under the workspace, with the version taken from `OOP_RELEASE.json`. The
 * client supplies no path and no sidecar file (`.sha256`, `.json`) is read.
 * Symlinks are refused at every step, and the file must resolve inside the root.
 */
export const locateArtifact = Effect.fn("MacArtifactRunner.locateArtifact")(function* (
  workspaceRoot: string,
) {
  const root = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(workspaceRoot),
    catch: () => notFound("The project folder does not exist."),
  });
  const releaseFile = NodePath.join(root, "OOP_RELEASE.json");
  const releaseStat = yield* lstatOrNotFound(releaseFile, "OOP_RELEASE.json was not found.");
  if (!releaseStat.isFile() || releaseStat.size > RELEASE_FILE_MAX_BYTES) {
    return yield* notFound("OOP_RELEASE.json must be a regular file under 4 KB.");
  }
  const release = yield* Effect.tryPromise(() => NodeFSP.readFile(releaseFile, "utf8")).pipe(
    Effect.flatMap(decodeReleaseFile),
    Effect.mapError(() => notFound("OOP_RELEASE.json must contain a version such as 0.0.45.")),
  );

  const fileName = `OoP-${release.version}-arm64.dmg`;
  const relativePath = NodePath.join("release", "macos", fileName);
  for (const folder of ["release", NodePath.join("release", "macos")]) {
    const stat = yield* lstatOrNotFound(NodePath.join(root, folder), `${folder} was not found.`);
    if (!stat.isDirectory()) return yield* notFound(`${folder} must be a real folder.`);
  }
  const dmgPath = NodePath.join(root, relativePath);
  const dmg = yield* lstatOrNotFound(dmgPath, `${fileName} was not found in release/macos.`);
  if (!dmg.isFile()) return yield* notFound(`${fileName} must be a regular file.`);
  if (dmg.size > ARTIFACT_MAX_BYTES) return yield* notFound(`${fileName} is larger than 4 GiB.`);
  const resolved = yield* Effect.tryPromise({
    try: () => NodeFSP.realpath(dmgPath),
    catch: () => notFound(`${fileName} could not be resolved.`),
  });
  if (resolved !== dmgPath) return yield* notFound(`${fileName} resolves outside the project.`);

  return {
    workspaceRoot: root,
    relativePath,
    fileName,
    appVersion: release.version,
    dmgPath,
    dev: dmg.dev,
    ino: dmg.ino,
  } satisfies LocatedArtifact;
});

type ArtifactRecord = NonNullable<ReleaseVerificationAttempt["artifact"]>;

/**
 * Reads the located DMG once, hashing as it goes and optionally copying the
 * same bytes to `destination`. The file is opened without following symlinks
 * and must still be the file that was located.
 */
async function readArtifact(
  artifact: LocatedArtifact,
  destination: string | null,
  signal: AbortSignal,
): Promise<ArtifactRecord> {
  const source = await NodeFSP.open(
    artifact.dmgPath,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
  );
  try {
    const before = await source.stat();
    if (!before.isFile() || before.dev !== artifact.dev || before.ino !== artifact.ino) {
      throw new Refusal("The build file changed while it was being opened.");
    }
    const target = destination === null ? null : await NodeFSP.open(destination, "wx", 0o600);
    try {
      const hash = NodeCrypto.createHash("sha256");
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let total = 0;
      for (;;) {
        signal.throwIfAborted();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > ARTIFACT_MAX_BYTES) throw new Refusal("The build file is larger than 4 GiB.");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (target !== null) await target.writeFile(chunk);
      }
      const after = await source.stat();
      if (after.size !== total || after.mtimeMs !== before.mtimeMs) {
        throw new Refusal("The build file changed while it was being read.");
      }
      return {
        workspaceRoot: artifact.workspaceRoot,
        relativePath: artifact.relativePath,
        fileName: artifact.fileName,
        appVersion: artifact.appVersion,
        sha256: hash.digest("hex"),
        size: total,
        ino: before.ino,
        mtimeMs: before.mtimeMs,
      };
    } finally {
      await target?.close();
    }
  } finally {
    await source.close();
  }
}

/** The SHA-256 of the located file as it is right now. Fails if it cannot be read cleanly. */
export const hashArtifact = (artifact: LocatedArtifact) =>
  Effect.tryPromise({
    try: (signal) => readArtifact(artifact, null, signal),
    catch: failureDetail,
  }).pipe(Effect.map((record) => record.sha256));

interface StepResult {
  readonly status: "passed" | "failed" | "timed-out" | "not-run";
  readonly detail: string;
  readonly exitCode?: number | null;
  readonly tail?: ReadonlyArray<string>;
}

const failed = (detail: string): StepResult => ({ status: "failed", detail });

const lastLines = (...texts: ReadonlyArray<string>) =>
  texts
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .slice(-RELEASE_VERIFICATION_TAIL_MAX_LINES)
    .map((line) => clamp(line, RELEASE_VERIFICATION_TAIL_LINE_MAX_LENGTH));

type ToolResult =
  | {
      readonly kind: "exited";
      readonly code: number | null;
      readonly stdout: string;
      readonly stderr: string;
    }
  | { readonly kind: "timed-out" }
  | { readonly kind: "unstarted"; readonly reason: string };

/** Runs one fixed tool. A tool that cannot start is reported, never thrown. */
const runTool = (command: string, args: ReadonlyArray<string>, timeout: Duration.Duration) =>
  Effect.flatMap(ProcessRunner.ProcessRunner, (runner) =>
    runner.run({
      command,
      args,
      timeout,
      timeoutBehavior: "timedOutResult",
      outputMode: "truncate",
      maxOutputBytes: TOOL_OUTPUT_MAX_BYTES,
    }),
  ).pipe(
    Effect.map((output): ToolResult =>
      output.timedOut
        ? { kind: "timed-out" }
        : { kind: "exited", code: output.code, stdout: output.stdout, stderr: output.stderr },
    ),
    Effect.catch((error) =>
      Effect.succeed<ToolResult>({
        kind: "unstarted",
        reason: `${NodePath.basename(command)} could not run (${error._tag})`,
      }),
    ),
  );

const COPY_TIMEOUT = Duration.seconds(120);
const COPY_VERIFY_TIMEOUT = Duration.seconds(120);
const DELETE_TIMEOUT = Duration.seconds(60);

const STEP_TIMEOUTS = {
  sha256: Duration.seconds(120),
  "image-verify": Duration.seconds(180),
  "mount-readonly": Duration.seconds(60),
  "app-bundle": Duration.seconds(10),
  "codesign-strict": Duration.seconds(120),
  // The copy, the copy's signature check, and the launch with its own bounded cleanup in turn.
  "launch-smoke": Duration.sum(
    Duration.sum(COPY_TIMEOUT, COPY_VERIFY_TIMEOUT),
    LAUNCH_SMOKE_TIMEOUT,
  ),
} as const satisfies Record<ReleaseVerificationCheckId, Duration.Duration>;

/** One check that is a single fixed tool invocation: it passes on exit code 0. */
const toolStep = (
  id: ReleaseVerificationCheckId,
  label: string,
  command: string,
  args: ReadonlyArray<string>,
) =>
  runTool(command, args, STEP_TIMEOUTS[id]).pipe(
    Effect.map((result): StepResult => {
      switch (result.kind) {
        case "timed-out":
          return {
            status: "timed-out",
            detail: `${label} timed out after ${Duration.toSeconds(STEP_TIMEOUTS[id])}s`,
          };
        case "unstarted":
          // The tool never ran, so nothing was observed failing: unproven, like the launch step.
          return { status: "not-run", detail: result.reason };
        case "exited":
          return {
            status: result.code === 0 ? "passed" : "failed",
            exitCode: result.code,
            detail:
              result.code === 0 ? `${label} succeeded` : `${label} exited with ${result.code}`,
            tail: lastLines(result.stdout, result.stderr),
          };
      }
    }),
  );

export type IsMounted = (mountPoint: string, runDir: string) => Effect.Effect<boolean>;

/**
 * A mounted volume has its own device id, so the mount point differs from the
 * folder around it. A missing path is not mounted; any other failure to look
 * counts as mounted, so nothing is deleted on a guess.
 */
const isMountedOnDisk: IsMounted = (mountPoint, runDir) =>
  Effect.tryPromise(async () => {
    try {
      const [mounted, parent] = await Promise.all([NodeFSP.stat(mountPoint), NodeFSP.stat(runDir)]);
      return mounted.dev !== parent.dev;
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") return false;
      throw cause;
    }
  }).pipe(Effect.orElseSucceed(() => true));

const unmount = (mountPoint: string, force: boolean) =>
  runTool(HDIUTIL, ["detach", ...(force ? ["-force"] : []), mountPoint], Duration.seconds(30));

/** Why a folder was kept: an app launched from it may still be running. */
export const LAUNCH_MAY_RUN_NOTE =
  "A launched app may still be running from the temporary folder, so it was left in place for manual recovery.";

/**
 * Whether the launch helper's marker is in the folder. Anything but a clear "no
 * such file" counts as present, so a folder is never deleted on a guess.
 */
const launchMarkerPresent = (runDir: string) =>
  Effect.tryPromise(async () => {
    try {
      await NodeFSP.lstat(NodePath.join(runDir, LAUNCH_UNCONFIRMED_MARKER));
      return true;
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") return false;
      throw cause;
    }
  }).pipe(Effect.orElseSucceed(() => true));

/** Detaches the image if it is mounted. Returns why it is still mounted, or null. */
const unmountOwned = (runDir: string, isMounted: IsMounted) =>
  Effect.gen(function* () {
    const mountPoint = NodePath.join(runDir, "mnt");
    if (yield* isMounted(mountPoint, runDir)) {
      yield* unmount(mountPoint, false);
      if (yield* isMounted(mountPoint, runDir)) yield* unmount(mountPoint, true);
      if (yield* isMounted(mountPoint, runDir)) {
        return "The disk image could not be unmounted, so its temporary folder was left in place.";
      }
    }
    return null;
  });

/** Whether the path is clearly absent. Any other answer, or a failure to look, counts as present. */
const runDirGone = (runDir: string) =>
  Effect.tryPromise(async () => {
    try {
      await NodeFSP.lstat(runDir);
      return false;
    } catch (cause) {
      if (errnoCode(cause) === "ENOENT") return true;
      throw cause;
    }
  }).pipe(Effect.orElseSucceed(() => false));

/**
 * Unmounts the image and deletes the private folder, in that order. The folder
 * is only deleted once nothing is mounted under it and no launch marker says an
 * app may still run from it. Returns why cleanup could not finish, or null.
 *
 * The delete is the system `rm`, not Node's: under Electron, Node's fs reads the
 * copied app's `app.asar` as a folder and cannot remove it. `-x` keeps `rm` from
 * crossing into a mount the checks above missed. Only exit 0 with the folder
 * confirmed absent counts; a timeout or a tool that cannot start does not.
 */
export const cleanupRunDir = (runDir: string, isMounted: IsMounted = isMountedOnDisk) =>
  Effect.gen(function* () {
    const stuck = yield* unmountOwned(runDir, isMounted);
    if (stuck !== null) return stuck;
    if (yield* launchMarkerPresent(runDir)) return LAUNCH_MAY_RUN_NOTE;
    const removed = yield* runTool(RM, ["-rfx", "--", runDir], DELETE_TIMEOUT);
    const deleted = removed.kind === "exited" && removed.code === 0 && (yield* runDirGone(runDir));
    return deleted ? null : "The temporary folder could not be deleted.";
  });

/**
 * The end of a run in which a launched app may still be running: the image is
 * unmounted (the app runs from its own copy), the folder is kept, and the
 * reason is returned for the record. Never deletes or signals anything.
 */
const keepRunDirForLaunch = (runDir: string, isMounted: IsMounted) =>
  Effect.map(unmountOwned(runDir, isMounted), (stuck) =>
    stuck === null ? LAUNCH_MAY_RUN_NOTE : `${LAUNCH_MAY_RUN_NOTE} ${stuck}`,
  );

/**
 * Cleanup for a folder left behind by a previous server process. It only acts
 * on a folder this feature made: the exact name under the temp directory, a
 * real directory, holding a marker with the same attempt id. Anything else is
 * left alone. Returns why it could not clean up, or null once the folder is gone.
 */
export const removeOwnedRunDir = (
  attempt: Pick<ReleaseVerificationAttempt, "attemptId" | "runDir">,
  tempRoot: string,
  isMounted: IsMounted = isMountedOnDisk,
) =>
  Effect.gen(function* () {
    const runDir = attempt.runDir;
    if (
      runDir === null ||
      !ATTEMPT_ID_PATTERN.test(attempt.attemptId) ||
      runDir !== NodePath.join(tempRoot, `${RUN_DIR_PREFIX}${attempt.attemptId}`)
    ) {
      return "The temporary folder is not one this server created, so it was left in place.";
    }
    const owned = yield* Effect.tryPromise(async () => {
      const stat = await NodeFSP.lstat(runDir).catch((cause: unknown) =>
        errnoCode(cause) === "ENOENT" ? null : Promise.reject(cause),
      );
      if (stat === null) return "gone" as const;
      if (!stat.isDirectory()) return "foreign" as const;
      const marker = await NodeFSP.readFile(NodePath.join(runDir, RUN_DIR_MARKER), "utf8");
      return marker === attempt.attemptId ? ("owned" as const) : ("foreign" as const);
    }).pipe(Effect.orElseSucceed(() => "foreign" as const));
    if (owned === "gone") return null;
    if (owned === "foreign") {
      return "The temporary folder has no matching ownership marker, so it was left in place.";
    }
    // Whatever the record says about the launch, a marker means an unknown app may be running:
    // refuse before anything is detached or deleted.
    if (yield* launchMarkerPresent(runDir)) return LAUNCH_MAY_RUN_NOTE;
    return yield* cleanupRunDir(runDir, isMounted);
  });

/**
 * Where run folders live. A Mac uses `/tmp`, whose real path `/private/tmp` keeps the
 * folder short enough for the launched app's Unix sockets; other hosts use the OS temp.
 */
export const runTempDir = (platform: string) =>
  platform === "darwin" ? MAC_TEMP_DIR : NodeOS.tmpdir();

/** The temp directory run folders live under, resolved so path checks compare real paths. */
export const resolveTempRoot = (tempDir: string) =>
  Effect.tryPromise({
    try: () => NodeFSP.realpath(tempDir),
    catch: (cause) =>
      new TempRootUnavailableError({
        message: `The temporary directory is unavailable (${errnoCode(cause) ?? "unknown"}).`,
      }),
  });

const createRunDir = (tempRoot: string, attemptId: string) =>
  Effect.tryPromise({
    try: async () => {
      if (!ATTEMPT_ID_PATTERN.test(attemptId)) throw new Refusal("Invalid attempt id.");
      const runDir = NodePath.join(tempRoot, `${RUN_DIR_PREFIX}${attemptId}`);
      // Not recursive: an existing folder is an error, never adopted.
      await NodeFSP.mkdir(runDir, { mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(runDir, RUN_DIR_MARKER), attemptId, {
        flag: "wx",
        mode: 0o600,
      });
      await NodeFSP.mkdir(NodePath.join(runDir, "mnt"), { mode: 0o700 });
      await NodeFSP.mkdir(NodePath.join(runDir, LAUNCH_DIR), { mode: 0o700 });
      return runDir;
    },
    catch: (cause) =>
      new RunDirCreateError({
        message: `The verification work folder could not be created (${failureDetail(cause)}).`,
      }),
  });

/** What the runner reports as it goes; the caller owns the attempt record. */
export interface RunnerPatch {
  readonly runDir?: string | null;
  readonly artifact?: ArtifactRecord;
  readonly checks?: ReadonlyArray<ReleaseVerificationCheck>;
  readonly error?: string;
}

export const pendingChecks = (): Array<ReleaseVerificationCheck> =>
  RELEASE_VERIFICATION_REQUIRED_CHECKS.map((id) => ({
    id,
    status: "pending",
    startedAt: null,
    endedAt: null,
    exitCode: null,
    detail: null,
    tail: [],
  }));

/** Reads one string key out of the app's Info.plist with the system tool. */
const plistValue = (infoPlist: string, key: string) =>
  runTool(PLUTIL, ["-extract", key, "raw", "-o", "-", infoPlist], Duration.seconds(5)).pipe(
    Effect.map((result) =>
      result.kind === "exited" && result.code === 0 ? result.stdout.trim() : null,
    ),
  );

const lstatOption = (path: string) =>
  Effect.tryPromise(() => NodeFSP.lstat(path)).pipe(Effect.option);

const checkAppBundle = (mountPoint: string, appVersion: string) =>
  Effect.gen(function* () {
    const app = NodePath.join(mountPoint, APP_NAME);
    const appStat = yield* lstatOption(app);
    if (Option.isNone(appStat) || !appStat.value.isDirectory()) {
      return failed(`${APP_NAME} is missing from the image or is not a real folder.`);
    }
    const infoPlist = NodePath.join(app, "Contents", "Info.plist");
    const infoStat = yield* lstatOption(infoPlist);
    if (Option.isNone(infoStat) || !infoStat.value.isFile()) {
      return failed("Info.plist is missing or is not a regular file.");
    }
    const executableName = yield* plistValue(infoPlist, "CFBundleExecutable");
    if (executableName === null || !EXECUTABLE_NAME_PATTERN.test(executableName)) {
      return failed("CFBundleExecutable is missing or not a plain file name.");
    }
    const executable = NodePath.join(app, "Contents", "MacOS", executableName);
    const executableStat = yield* lstatOption(executable);
    if (Option.isNone(executableStat) || !executableStat.value.isFile()) {
      return failed("The app executable is missing or is not a regular file.");
    }
    const resolved = yield* Effect.tryPromise(() =>
      Promise.all([NodeFSP.realpath(mountPoint), NodeFSP.realpath(executable)]),
    ).pipe(Effect.option);
    if (
      Option.isNone(resolved) ||
      !resolved.value[1].startsWith(`${resolved.value[0]}${NodePath.sep}`)
    ) {
      return failed("The app executable resolves outside the mounted image.");
    }
    const shortVersion = yield* plistValue(infoPlist, "CFBundleShortVersionString");
    if (shortVersion !== appVersion) {
      return failed(`The app reports version ${shortVersion ?? "none"}, expected ${appVersion}.`);
    }
    return { status: "passed", detail: `${APP_NAME} ${appVersion}` } satisfies StepResult;
  });

/**
 * Maps the launch helper's result to the check's. A pass counts only when the
 * helper confirmed its cleanup and the flag it was given agrees; otherwise the
 * pass is not proven ("not-run" claims no observed failure). Any other status
 * is kept as the helper reported it, and nothing here removes a check.
 */
export const toLaunchStep = (result: LaunchSmokeResult, launchMayRun: boolean): StepResult => {
  const unconfirmedPass =
    result.status === "passed" && !(result.cleanupSucceeded === true && !launchMayRun);
  return {
    status: unconfirmedPass ? "not-run" : result.status,
    detail: unconfirmedPass
      ? "Startup was observed, but the launched app is not confirmed gone, so it is not a pass."
      : result.detail,
    exitCode: null,
    tail: result.tail ?? [],
  };
};

/** Why a copy or verification tool did not finish, as a step that never started the app. */
const unfinishedStep = (
  result: ToolResult,
  what: string,
  timeout: Duration.Duration,
  whenExited: "failed" | "not-run",
): StepResult => {
  switch (result.kind) {
    case "timed-out":
      return {
        status: "timed-out",
        detail: `${what} timed out after ${Duration.toSeconds(timeout)}s; the app was not started.`,
      };
    case "unstarted":
      return { status: "not-run", detail: `${result.reason}; the app was not started.` };
    case "exited":
      return {
        status: whenExited,
        exitCode: result.code,
        detail: `${what} exited with ${result.code}; the app was not started.`,
        tail: lastLines(result.stdout, result.stderr),
      };
  }
};

/**
 * Copies the verified app out of the read-only image into the run folder, checks
 * the copy with the same strict signature check, and only then starts it. The
 * helper runs the launch and its own owned cleanup; `launchMayRun` is the flag
 * it keeps true from the moment a launch may happen until every owned process is
 * confirmed gone.
 */
const launchStep = (runDir: string, mountPoint: string, launchMayRun: Ref.Ref<boolean>) =>
  Effect.gen(function* () {
    const source = NodePath.join(mountPoint, APP_NAME);
    const copy = NodePath.join(runDir, LAUNCH_DIR, APP_NAME);

    const copied = yield* runTool(DITTO, [source, copy], COPY_TIMEOUT);
    if (copied.kind !== "exited" || copied.code !== 0) {
      return unfinishedStep(copied, "Copying the app for launch", COPY_TIMEOUT, "not-run");
    }
    const verified = yield* runTool(CODESIGN, [...CODESIGN_ARGS, copy], COPY_VERIFY_TIMEOUT);
    if (verified.kind !== "exited" || verified.code !== 0) {
      return unfinishedStep(verified, "The copy's signature check", COPY_VERIFY_TIMEOUT, "failed");
    }
    const result = yield* launchSmoke(runDir, (value) => Ref.set(launchMayRun, value));
    return toLaunchStep(result, yield* Ref.get(launchMayRun));
  });

interface RunChecksInput<E> {
  readonly attemptId: string;
  readonly artifact: LocatedArtifact;
  readonly tempRoot: string;
  readonly onUpdate: (patch: RunnerPatch) => Effect.Effect<void, E>;
  readonly isMounted?: IsMounted;
}

/**
 * What runs and what is released: the image is unmounted whether the run passes,
 * fails, times out, or is interrupted, and the folder is deleted too, unless a
 * launched app may still be running from it. Then the folder is kept and the run
 * ends with an error that says so. A check that does not pass stops the run; the
 * rest are recorded as not run. Progress goes out through `onUpdate`, whose
 * failure stops the run.
 */
const checkAndRelease = <E>(input: RunChecksInput<E>, launchMayRun: Ref.Ref<boolean>) =>
  Effect.acquireUseRelease(
    createRunDir(input.tempRoot, input.attemptId),
    (runDir) =>
      Effect.gen(function* () {
        // Reported inside `use` so a failed write still reaches the cleanup below.
        yield* input.onUpdate({ runDir });
        const copy = NodePath.join(runDir, "artifact.dmg");
        const mountPoint = NodePath.join(runDir, "mnt");
        let checks = pendingChecks();
        const patchCheck = (
          id: ReleaseVerificationCheckId,
          patch: Partial<ReleaseVerificationCheck>,
        ) => {
          checks = checks.map((check) => (check.id === id ? { ...check, ...patch } : check));
          return input.onUpdate({ checks });
        };

        const steps: Record<
          ReleaseVerificationCheckId,
          Effect.Effect<StepResult, E, ProcessRunner.ProcessRunner>
        > = {
          sha256: Effect.tryPromise({
            try: (signal) => readArtifact(input.artifact, copy, signal),
            catch: failureDetail,
          }).pipe(
            Effect.matchEffect({
              onFailure: (detail) => Effect.succeed(failed(detail)),
              onSuccess: (record) =>
                input.onUpdate({ artifact: record }).pipe(
                  Effect.as<StepResult>({
                    status: "passed",
                    detail: `sha256 ${record.sha256.slice(0, 12)}`,
                  }),
                ),
            }),
          ),
          "image-verify": toolStep("image-verify", "hdiutil verify", HDIUTIL, ["verify", copy]),
          "mount-readonly": toolStep("mount-readonly", "hdiutil attach", HDIUTIL, [
            "attach",
            "-readonly",
            "-nobrowse",
            "-noautoopen",
            "-mountpoint",
            mountPoint,
            copy,
          ]),
          "app-bundle": checkAppBundle(mountPoint, input.artifact.appVersion),
          "codesign-strict": toolStep("codesign-strict", "codesign", CODESIGN, [
            ...CODESIGN_ARGS,
            NodePath.join(mountPoint, APP_NAME),
          ]),
          "launch-smoke": launchStep(runDir, mountPoint, launchMayRun),
        };

        let blockedBy: ReleaseVerificationCheckId | null = null;
        for (const id of RELEASE_VERIFICATION_REQUIRED_CHECKS) {
          if (blockedBy !== null) {
            yield* patchCheck(id, {
              status: "not-run",
              detail: `Not run: ${blockedBy} did not pass.`,
            });
            continue;
          }
          yield* patchCheck(id, { status: "running", startedAt: yield* nowIso });
          const outcome = yield* steps[id].pipe(
            Effect.timeoutOption(Duration.sum(STEP_TIMEOUTS[id], STEP_TIMEOUT_BACKSTOP)),
          );
          const result: StepResult = Option.getOrElse(outcome, (): StepResult => ({
            status: "timed-out",
            detail: `Timed out after ${Duration.toSeconds(STEP_TIMEOUTS[id])}s`,
          }));
          yield* patchCheck(id, {
            status: result.status,
            endedAt: yield* nowIso,
            exitCode: result.exitCode ?? null,
            detail: clamp(result.detail, RELEASE_VERIFICATION_DETAIL_MAX_LENGTH),
            tail: result.tail ?? [],
          });
          if (result.status !== "passed") blockedBy = id;
        }
      }),
    // Runs after the launch helper's own cleanup, which interruption waits for. The record write
    // is bounded so a stuck engine cannot hold up server shutdown.
    (runDir) =>
      Effect.gen(function* () {
        // The flag and the marker both mean an app may run from the folder; either is enough.
        const mayRun = (yield* Ref.get(launchMayRun)) || (yield* launchMarkerPresent(runDir));
        const problem = mayRun
          ? yield* keepRunDirForLaunch(runDir, input.isMounted ?? isMountedOnDisk)
          : yield* cleanupRunDir(runDir, input.isMounted);
        yield* input
          .onUpdate(problem === null ? { runDir: null } : { error: problem })
          .pipe(Effect.timeoutOption(Duration.seconds(10)));
      }).pipe(Effect.ignore),
  );

/**
 * Runs the six checks in order against a private copy of the DMG. See
 * `checkAndRelease` for what is released and when the folder is kept.
 */
export const runMacArtifactChecks = <E>(input: RunChecksInput<E>) =>
  // The flag exists before the folder does, so no path can reach the release without it.
  Effect.flatMap(Ref.make(false), (launchMayRun) => checkAndRelease(input, launchMayRun));
