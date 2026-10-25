// @effect-diagnostics nodeBuiltinImport:off - The fake runs as a ProcessRunner, whose effects carry
// no services, so it builds the mounted app layout with the native fs and path directly.
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ProcessRunner from "../processRunner.ts";

export const RELEASE_TEST_VERSION = "0.0.45";
export const RELEASE_TEST_DMG_CONTENTS = "pretend disk image bytes";

/** The JSON text of any value, for writing fixture files. */
export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A workspace laid out the way the packager leaves it: the release file and one DMG. */
export const makeReleaseWorkspace = (version = RELEASE_TEST_VERSION) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-verify-workspace-" });
    yield* fileSystem.writeFileString(path.join(root, "OOP_RELEASE.json"), encodeJson({ version }));
    yield* fileSystem.makeDirectory(path.join(root, "release", "macos"), { recursive: true });
    const dmgPath = path.join(root, "release", "macos", `OOP-${version}-arm64.dmg`);
    yield* fileSystem.writeFileString(dmgPath, RELEASE_TEST_DMG_CONTENTS);
    return { root, dmgPath };
  });

/** The process id the fake launcher reports. It is nothing real: no tool here starts a process. */
const FAKE_APP_PID = 424_242;

/** `ps`'s `lstart` text for a moment, as it prints under TZ=UTC: `Thu Oct  2 12:00:00 2026`. */
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
const lstartOf = (ms: number) => {
  const parts = DateTime.toPartsUtc(DateTime.makeUnsafe(ms));
  const two = (value: number) => String(value).padStart(2, "0");
  const clock = `${two(parts.hour)}:${two(parts.minute)}:${two(parts.second)}`;
  return `${WEEKDAYS[parts.weekDay] ?? ""} ${MONTH_NAMES[parts.month - 1] ?? ""} ${String(parts.day).padStart(2, " ")} ${clock} ${parts.year}`;
};

/**
 * Stands in for hdiutil, plutil, codesign, ditto, env, ps, kill, and rm so the
 * verification code runs against real folders without mounting anything or
 * starting an app. `attach` builds the app layout the checks read inside the
 * requested mount point, `ditto` builds the copy, and `mounted` follows attach
 * and detach so cleanup can be observed.
 *
 * The fake launcher never starts anything. By default it prints the launch
 * helper's own setup error, which means "not started, nothing to clean up". It
 * answers only the exact form `/usr/bin/env -u ELECTRON_RUN_AS_NODE
 * /usr/bin/osascript ...`; a launcher without the strip, or a bare `osascript`,
 * gets "command not found". Likewise `rm` answers only `/bin/rm -rfx -- <folder>`
 * and, like the real one, deletes that folder for real.
 */
export interface FakeMacTools {
  readonly processRunner: ProcessRunner.ProcessRunner["Service"];
  /** Every invocation in order: the tool's file name and its arguments. */
  readonly calls: Array<{ readonly name: string; readonly args: ReadonlyArray<string> }>;
  /** `appAlive` is the pretend launched app: listed by `ps` until a `kill` names it. */
  readonly state: { mounted: boolean; appAlive: boolean };
  /**
   * The mount check that matches this fake. Pass it to the runner explicitly: the real one
   * compares device ids, and the fake mount lives on the folder's own filesystem, so code that
   * uses the real check (the service) never sees it as mounted and never detaches.
   */
  readonly isMounted: () => Effect.Effect<boolean>;
}

export const makeFakeMacTools = (options: {
  readonly version: string;
  readonly verifyExit?: number;
  readonly attach?: "ok" | "timeout";
  readonly detachFails?: boolean;
  /** Runs when codesign is called; a hook that never returns simulates a hung tool. */
  readonly onCodesign?: Effect.Effect<void>;
  /** Runs when a detach is called, before it takes effect; a gate here holds cleanup open. */
  readonly onDetach?: Effect.Effect<void>;
  /** Exit code of `ditto`; a non-zero one builds no copy. */
  readonly dittoExit?: number;
  /** Exit code of codesign on the launch copy only: the mounted app still verifies. */
  readonly copyCodesignExit?: number;
  /** Exit code of `rm`; a non-zero one deletes nothing. */
  readonly rmExit?: number;
  /** `rm` exits 0 but leaves the folder in place, which cleanup must not take as deleted. */
  readonly rmKeepsFolder?: boolean;
  /**
   * What the launcher's `osascript` prints. `never-launched` (the default) is the helper's
   * explicit setup error. `unusable` is output the helper cannot read, which leaves a launch
   * possibly running. `started` reports the fake app, which `ps` lists until `kill` is called.
   */
  readonly launcher?: "never-launched" | "unusable" | "started";
  /** Runs on each `ps` call, so a test can wait until the helper is watching the app. */
  readonly onProcessList?: Effect.Effect<void>;
  /** A tool (by file name) that cannot be started at all, like a missing or unrunnable binary. */
  readonly cannotStart?: string;
}): FakeMacTools => {
  const calls: FakeMacTools["calls"] = [];
  const state = { mounted: false, appAlive: false };
  let appStartedAt = 0;
  const output = (code: number, stdout = "", stderr = ""): ProcessRunner.ProcessRunOutput => ({
    stdout,
    stderr,
    code: ChildProcessSpawner.ExitCode(code),
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
    stderrInvalidUtf8: false,
  });
  const timedOut: ProcessRunner.ProcessRunOutput = { ...output(0), code: null, timedOut: true };

  const buildApp = (appPath: string) =>
    Effect.promise(async () => {
      const contents = NodePath.join(appPath, "Contents");
      await NodeFSP.mkdir(NodePath.join(contents, "MacOS"), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(contents, "Info.plist"), "<plist/>");
      await NodeFSP.writeFile(NodePath.join(contents, "MacOS", "OOP"), "#!/bin/sh\n");
    });

  const processRunner: FakeMacTools["processRunner"] = {
    run: (input) =>
      Effect.gen(function* () {
        const name = NodePath.basename(input.command);
        calls.push({ name, args: input.args });
        if (options.cannotStart === name) {
          return yield* new ProcessRunner.ProcessSpawnError({
            command: name,
            argumentCount: input.args.length,
            cause: "the tool cannot be started",
          });
        }
        const verb = input.args[0];
        if (name === "hdiutil" && verb === "verify") {
          return output(options.verifyExit ?? 0, "", options.verifyExit ? "verify failed" : "");
        }
        if (name === "hdiutil" && verb === "attach") {
          state.mounted = true;
          if (options.attach === "timeout") return timedOut;
          const mountPoint = input.args[input.args.indexOf("-mountpoint") + 1] ?? "";
          yield* buildApp(NodePath.join(mountPoint, "OOP.app"));
          return output(0);
        }
        if (name === "hdiutil" && verb === "detach") {
          yield* options.onDetach ?? Effect.void;
          if (options.detachFails) return output(1, "", "Resource busy");
          state.mounted = false;
          return output(0);
        }
        if (name === "plutil") {
          const key = input.args[1];
          return output(0, `${key === "CFBundleExecutable" ? "OOP" : options.version}\n`);
        }
        if (name === "codesign") {
          yield* options.onCodesign ?? Effect.void;
          const target = input.args.at(-1) ?? "";
          const onCopy = target.endsWith(`${NodePath.sep}launch${NodePath.sep}OOP.app`);
          if (onCopy && options.copyCodesignExit) {
            return output(options.copyCodesignExit, "", "invalid signature");
          }
          return output(0, "", "valid on disk\nsatisfies its Designated Requirement");
        }
        if (name === "ditto") {
          if (options.dittoExit) return output(options.dittoExit, "", "ditto: no space left");
          yield* buildApp(input.args[1] ?? "");
          return output(0);
        }
        if (input.command === "/usr/bin/env") {
          const [unset, variable, tool, ...osascriptArgs] = input.args;
          const stripped =
            unset === "-u" && variable === "ELECTRON_RUN_AS_NODE" && tool === "/usr/bin/osascript";
          if (!stripped) return output(127, "", "unexpected env invocation");
          switch (options.launcher ?? "never-launched") {
            case "never-launched":
              return output(0, encodeJson({ prepareError: "fake launcher: no app is started" }));
            case "unusable":
              return output(0, "not a launcher reply");
            case "started":
              state.appAlive = true;
              appStartedAt = yield* Clock.currentTimeMillis;
              // `osascript -l JavaScript -e <script>`, then the app path and the environment.
              return output(
                0,
                encodeJson({ pid: FAKE_APP_PID, bundlePath: osascriptArgs[4] ?? null }),
              );
          }
        }
        if (input.command === "/bin/rm") {
          // Only ever a run folder: a cleanup that aims elsewhere must not delete it for real.
          const [flags, separator, target = "", ...extra] = input.args;
          const exact =
            flags === "-rfx" &&
            separator === "--" &&
            extra.length === 0 &&
            NodePath.isAbsolute(target) &&
            NodePath.basename(target).startsWith("t3v-");
          if (!exact) return output(64, "", "unexpected rm invocation");
          if (options.rmExit) return output(options.rmExit, "", "rm: Resource busy");
          if (!options.rmKeepsFolder) {
            yield* Effect.promise(() => NodeFSP.rm(target, { recursive: true, force: true }));
          }
          return output(0);
        }
        if (name === "ps") {
          yield* options.onProcessList ?? Effect.void;
          const listed = [`    1     0 Ss   ${lstartOf(0)}`];
          if (state.appAlive) {
            listed.push(`${FAKE_APP_PID}     1 S    ${lstartOf(appStartedAt)}`);
          }
          return output(0, `${listed.join("\n")}\n`);
        }
        if (name === "kill") {
          if (input.args.includes(String(FAKE_APP_PID))) state.appAlive = false;
          return output(0);
        }
        return output(127, "", `unexpected command ${name}`);
      }),
  };

  return { processRunner, calls, state, isMounted: () => Effect.sync(() => state.mounted) };
};
