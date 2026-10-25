import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ReleaseVerificationArtifactNotFoundError } from "@t3tools/contracts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeCrypto from "node:crypto";

import * as ProcessRunner from "../processRunner.ts";
import {
  encodeJson,
  makeFakeMacTools,
  makeReleaseWorkspace as makeWorkspace,
  RELEASE_TEST_DMG_CONTENTS as DMG_CONTENTS,
  RELEASE_TEST_VERSION as VERSION,
  type FakeMacTools,
} from "../testUtils/fakeMacTools.ts";
import {
  cleanupRunDir,
  LAUNCH_MAY_RUN_NOTE,
  locateArtifact,
  removeOwnedRunDir,
  resolveTempRoot,
  runMacArtifactChecks,
  toLaunchStep,
  type RunnerPatch,
} from "./MacArtifactRunner.ts";
import { LAUNCH_UNCONFIRMED_MARKER, type LaunchSmokeResult } from "./MacLaunchSmoke.ts";

// Short on purpose, like the real `/private/tmp/t3v-<uuid>`: the launch helper refuses a run
// folder over 54 bytes, so a long OS temp path would end every run before the launcher.
const makeTempRoot = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    directory: "/tmp",
    prefix: "t3r-",
  });
  return yield* resolveTempRoot(directory);
});

/** Every patch carries the full set of checks, so the last one is the final state. */
const latestChecks = (patches: ReadonlyArray<RunnerPatch>) =>
  patches.filter((patch) => patch.checks !== undefined).at(-1)?.checks ?? [];

const checkSummary = (patches: ReadonlyArray<RunnerPatch>) =>
  latestChecks(patches).map((check) => [check.id, check.status] as const);

const prepareRun = (workspaceRoot: string, tempRoot: string, tools: FakeMacTools) =>
  Effect.gen(function* () {
    const artifact = yield* locateArtifact(workspaceRoot);
    const patches: Array<RunnerPatch> = [];
    const run = runMacArtifactChecks({
      attemptId: "attempt-test-1",
      artifact,
      tempRoot,
      onUpdate: (patch) => Effect.sync(() => void patches.push(patch)),
      isMounted: tools.isMounted,
    }).pipe(Effect.provideService(ProcessRunner.ProcessRunner, tools.processRunner));
    return { artifact, patches, run };
  });

// Tools with a long argument list are named by tool alone, and codesign by what it checks. `env`
// only ever runs the launcher: the fake refuses any other form of it.
const callNames = (tools: FakeMacTools) =>
  tools.calls.map((call) => {
    if (call.name === "ditto" || call.name === "ps") return call.name;
    if (call.name === "env") return "env osascript";
    if (call.name === "kill") return `kill ${call.args[1]}`;
    if (call.name === "codesign" && (call.args.at(-1) ?? "").endsWith("/launch/OOP.app")) {
      return "codesign copy";
    }
    return `${call.name} ${call.args[0]}`;
  });

it.layer(NodeServices.layer, { excludeTestServices: true })("MacArtifactRunner", (it) => {
  describe("locateArtifact", () => {
    it.effect("finds the one DMG the release file names, inside the workspace", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();

        const located = yield* locateArtifact(workspace.root);

        expect(located).toMatchObject({
          fileName: `OOP-${VERSION}-arm64.dmg`,
          relativePath: `release/macos/OOP-${VERSION}-arm64.dmg`,
          appVersion: VERSION,
        });
        expect(located.dmgPath).toBe(yield* fileSystem.realPath(workspace.dmgPath));
      }),
    );

    it.effect("rejects a release file that does not hold a plain x.y.z version", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* makeWorkspace();
        const releaseFile = path.join(workspace.root, "OOP_RELEASE.json");

        for (const contents of [
          encodeJson({ version: "1.2" }),
          encodeJson({ version: "01.2.3" }),
          encodeJson({ version: "1.2.3-beta" }),
          encodeJson({ version: "../1.2.3" }),
          encodeJson({ version: "1.2.3\n; rm -rf /" }),
          encodeJson({}),
          "not json",
        ]) {
          yield* fileSystem.writeFileString(releaseFile, contents);
          const error = yield* locateArtifact(workspace.root).pipe(Effect.flip);
          expect(error).toBeInstanceOf(ReleaseVerificationArtifactNotFoundError);
        }
      }),
    );

    it.effect("does not accept a sidecar checksum or manifest in place of the DMG", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        yield* fileSystem.remove(workspace.dmgPath);
        yield* fileSystem.writeFileString(`${workspace.dmgPath}.sha256`, "deadbeef  OOP.dmg\n");
        yield* fileSystem.writeFileString(`${workspace.dmgPath}.json`, '{"verification":"passed"}');

        const error = yield* locateArtifact(workspace.root).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ReleaseVerificationArtifactNotFoundError);
      }),
    );

    it.effect.skipIf(!symlinksSupported)("rejects a symlinked DMG", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const workspace = yield* makeWorkspace();
        const outside = yield* fileSystem.makeTempDirectoryScoped();
        yield* fileSystem.writeFileString(path.join(outside, "other.dmg"), "outside");
        yield* fileSystem.remove(workspace.dmgPath);
        yield* fileSystem.symlink(path.join(outside, "other.dmg"), workspace.dmgPath);

        const error = yield* locateArtifact(workspace.root).pipe(Effect.flip);

        expect(error).toBeInstanceOf(ReleaseVerificationArtifactNotFoundError);
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "rejects a symlinked release folder, release/macos folder, or release file",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const outside = yield* fileSystem.makeTempDirectoryScoped();
          yield* fileSystem.makeDirectory(path.join(outside, "macos"), { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(outside, "macos", `OOP-${VERSION}-arm64.dmg`),
            "outside",
          );
          yield* fileSystem.writeFileString(
            path.join(outside, "release.json"),
            encodeJson({ version: VERSION }),
          );

          const linkedRelease = yield* makeWorkspace();
          yield* fileSystem.remove(path.join(linkedRelease.root, "release"), { recursive: true });
          yield* fileSystem.symlink(outside, path.join(linkedRelease.root, "release"));

          const linkedMacos = yield* makeWorkspace();
          yield* fileSystem.remove(path.join(linkedMacos.root, "release", "macos"), {
            recursive: true,
          });
          yield* fileSystem.symlink(
            path.join(outside, "macos"),
            path.join(linkedMacos.root, "release", "macos"),
          );

          const linkedReleaseFile = yield* makeWorkspace();
          yield* fileSystem.remove(path.join(linkedReleaseFile.root, "OOP_RELEASE.json"));
          yield* fileSystem.symlink(
            path.join(outside, "release.json"),
            path.join(linkedReleaseFile.root, "OOP_RELEASE.json"),
          );

          for (const workspace of [linkedRelease, linkedMacos, linkedReleaseFile]) {
            const error = yield* locateArtifact(workspace.root).pipe(Effect.flip);
            expect(error).toBeInstanceOf(ReleaseVerificationArtifactNotFoundError);
          }
        }),
    );
  });

  describe("failures", () => {
    it.effect("a missing temp directory is a tagged error that names the problem", () =>
      Effect.gen(function* () {
        const tempRoot = yield* makeTempRoot;

        const error = yield* resolveTempRoot(`${tempRoot}/missing`).pipe(Effect.flip);

        expect(error._tag).toBe("TempRootUnavailableError");
        expect(error.message).toContain("temporary directory is unavailable");
      }),
    );

    it.effect("an uncreatable work folder is a tagged error, with no tool run and no record", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION });
        const { patches, run } = yield* prepareRun(workspace.root, `${tempRoot}/missing`, tools);

        const error = yield* run.pipe(Effect.flip);

        expect(error._tag).toBe("RunDirCreateError");
        expect(error.message).toContain("work folder could not be created");
        expect(patches).toEqual([]);
        expect(tools.calls).toEqual([]);
      }),
    );
  });

  describe("runMacArtifactChecks", () => {
    it.effect(
      "checks a private copy, records five passes and an unrun startup check, and removes its folder",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const workspace = yield* makeWorkspace();
          const tempRoot = yield* makeTempRoot;
          const tools = makeFakeMacTools({ version: VERSION });
          const { artifact, patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

          yield* run;

          expect(checkSummary(patches)).toEqual([
            ["sha256", "passed"],
            ["image-verify", "passed"],
            ["mount-readonly", "passed"],
            ["app-bundle", "passed"],
            ["codesign-strict", "passed"],
            ["launch-smoke", "not-run"],
          ]);
          const launch = latestChecks(patches).find((check) => check.id === "launch-smoke");
          // The fake launcher says nothing was started, which is a not-run with a stated reason.
          expect(launch?.detail).toContain("Launcher setup failed");
          expect(patches.find((patch) => patch.artifact !== undefined)?.artifact).toMatchObject({
            sha256: NodeCrypto.createHash("sha256").update(DMG_CONTENTS).digest("hex"),
            size: Buffer.byteLength(DMG_CONTENTS),
            fileName: artifact.fileName,
            appVersion: VERSION,
          });

          // Everything after the copy reads the private copy, never the original.
          const verified = tools.calls.find((call) => call.args[0] === "verify")?.args[1] ?? "";
          expect(verified.startsWith(`${tempRoot}/t3v-attempt-test-1/`)).toBe(true);
          expect(verified).not.toBe(artifact.dmgPath);
          expect(callNames(tools)).toEqual([
            "hdiutil verify",
            "hdiutil attach",
            "plutil -extract",
            "plutil -extract",
            "codesign --verify",
            "ditto",
            "codesign copy",
            "env osascript",
            "hdiutil detach",
            "rm -rfx",
          ]);

          const runDir = patches[0]?.runDir ?? "";
          expect(tools.calls.at(-1)?.args).toEqual(["-rfx", "--", runDir]);
          expect(yield* fileSystem.exists(runDir)).toBe(false);
          expect(patches.at(-1)).toEqual({ runDir: null });
        }),
    );

    it.effect("stops at the first check that fails and records the rest as not run", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION, verifyExit: 1 });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        expect(checkSummary(patches)).toEqual([
          ["sha256", "passed"],
          ["image-verify", "failed"],
          ["mount-readonly", "not-run"],
          ["app-bundle", "not-run"],
          ["codesign-strict", "not-run"],
          ["launch-smoke", "not-run"],
        ]);
        const failedCheck = latestChecks(patches).find((check) => check.id === "image-verify");
        expect(failedCheck).toMatchObject({ exitCode: 1, tail: ["verify failed"] });
        // Nothing was mounted, so nothing was unmounted; the folder is still removed.
        expect(callNames(tools)).toEqual(["hdiutil verify", "rm -rfx"]);
        expect(yield* fileSystem.exists(patches[0]?.runDir ?? "")).toBe(false);
      }),
    );

    it.effect("a tool that cannot start is not-run, never failed, and stops the run", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        // Nothing was observed failing: the same reading the launch step gives an unrunnable tool.
        const tools = makeFakeMacTools({ version: VERSION, cannotStart: "hdiutil" });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        expect(checkSummary(patches)).toEqual([
          ["sha256", "passed"],
          ["image-verify", "not-run"],
          ["mount-readonly", "not-run"],
          ["app-bundle", "not-run"],
          ["codesign-strict", "not-run"],
          ["launch-smoke", "not-run"],
        ]);
        const verify = latestChecks(patches).find((check) => check.id === "image-verify");
        expect(verify?.detail).toContain("hdiutil could not run");
        expect(callNames(tools)).toEqual(["hdiutil verify", "rm -rfx"]);
        expect(yield* fileSystem.exists(patches[0]?.runDir ?? "")).toBe(false);
      }),
    );

    it.effect("records a timed-out tool as timed out, not failed, and still detaches", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION, attach: "timeout" });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        expect(checkSummary(patches).map(([, status]) => status)).toEqual([
          "passed",
          "passed",
          "timed-out",
          "not-run",
          "not-run",
          "not-run",
        ]);
        // The attach may have half-completed before it was cut off.
        expect(callNames(tools).slice(-2)).toEqual(["hdiutil detach", "rm -rfx"]);
        expect(tools.state.mounted).toBe(false);
        expect(yield* fileSystem.exists(patches[0]?.runDir ?? "")).toBe(false);
      }),
    );

    it.effect("on cancel stops the running check, then unmounts, then deletes the folder", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const reachedCodesign = yield* Deferred.make<void>();
        const tools = makeFakeMacTools({
          version: VERSION,
          onCodesign: Deferred.succeed(reachedCodesign, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
        });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        const fiber = yield* run.pipe(Effect.forkChild);
        yield* Deferred.await(reachedCodesign);
        yield* Fiber.interrupt(fiber);

        expect(callNames(tools).slice(-3)).toEqual([
          "codesign --verify",
          "hdiutil detach",
          "rm -rfx",
        ]);
        expect(tools.state.mounted).toBe(false);
        expect(yield* fileSystem.exists(patches[0]?.runDir ?? "")).toBe(false);
        expect(checkSummary(patches).find(([id]) => id === "codesign-strict")?.[1]).toBe("running");
      }),
    );

    it.effect("on cancel keeps the image mounted and the folder until the unmount finishes", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const reachedCodesign = yield* Deferred.make<void>();
        const reachedDetach = yield* Deferred.make<void>();
        const finishDetach = yield* Deferred.make<void>();
        const tools = makeFakeMacTools({
          version: VERSION,
          onCodesign: Deferred.succeed(reachedCodesign, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          onDetach: Deferred.succeed(reachedDetach, undefined).pipe(
            Effect.andThen(Deferred.await(finishDetach)),
          ),
        });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        const fiber = yield* run.pipe(Effect.forkChild);
        yield* Deferred.await(reachedCodesign);
        const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
        yield* Deferred.await(reachedDetach);

        // The unmount is held open: the image is still mounted, the folder is still there, and
        // cleanup has not been reported.
        const runDir = patches[0]?.runDir ?? "";
        expect(runDir).not.toBe("");
        expect(tools.state.mounted).toBe(true);
        expect(yield* fileSystem.exists(runDir)).toBe(true);
        expect(callNames(tools)).not.toContain("rm -rfx");
        expect(patches.some((patch) => patch.runDir === null)).toBe(false);

        yield* Deferred.succeed(finishDetach, undefined);
        yield* Fiber.join(interrupting);
        expect(tools.state.mounted).toBe(false);
        expect(callNames(tools).at(-1)).toBe("rm -rfx");
        expect(yield* fileSystem.exists(runDir)).toBe(false);
        expect(patches.at(-1)).toEqual({ runDir: null });
      }),
    );

    it.effect("keeps the folder and reports an error when the image cannot be unmounted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION, detachFails: true });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        const runDir = patches[0]?.runDir ?? "";
        expect(patches.at(-1)?.error).toContain("could not be unmounted");
        expect(patches.some((patch) => patch.runDir === null)).toBe(false);
        // A forced detach is tried before giving up.
        const detaches = tools.calls.filter((call) => call.args[0] === "detach");
        expect(detaches.map((call) => call.args)).toEqual([
          ["detach", `${runDir}/mnt`],
          ["detach", "-force", `${runDir}/mnt`],
        ]);
        expect(yield* fileSystem.exists(runDir)).toBe(true);
        // Nothing is deleted while the image is still mounted, not even with `-x`.
        expect(callNames(tools)).not.toContain("rm -rfx");

        // Once the volume is gone a later cleanup finishes the job.
        tools.state.mounted = false;
        const problem = yield* cleanupRunDir(runDir, tools.isMounted).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, tools.processRunner),
        );
        expect(problem).toBeNull();
        expect(tools.calls.filter((call) => call.name === "rm")).toEqual([
          { name: "rm", args: ["-rfx", "--", runDir] },
        ]);
        expect(yield* fileSystem.exists(runDir)).toBe(false);
      }),
    );

    it.effect("keeps the folder and says so when rm fails, leaves it, or cannot start", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const notDeleted = { error: "The temporary folder could not be deleted." };
        const failures = [
          { rmExit: 1 },
          // Exit 0 alone is not enough: the folder has to be seen gone.
          { rmKeepsFolder: true },
          { cannotStart: "rm" },
        ] as const;

        for (const failure of failures) {
          const tempRoot = yield* makeTempRoot;
          const tools = makeFakeMacTools({ version: VERSION, ...failure });
          const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

          yield* run;

          const label = encodeJson(failure);
          const runDir = patches[0]?.runDir ?? "";
          // The one attempt at the delete is exact, and it came after the detach.
          expect(callNames(tools).slice(-2), label).toEqual(["hdiutil detach", "rm -rfx"]);
          expect(tools.calls.at(-1)?.args, label).toEqual(["-rfx", "--", runDir]);
          expect(patches.at(-1), label).toEqual(notDeleted);
          expect(
            patches.some((patch) => patch.runDir === null),
            label,
          ).toBe(false);
          expect(yield* fileSystem.exists(runDir), label).toBe(true);
          // Everything else still ran and passed; only the cleanup is reported.
          expect(
            checkSummary(patches).map(([, status]) => status),
            label,
          ).toEqual(["passed", "passed", "passed", "passed", "passed", "not-run"]);
        }
      }),
    );

    it.effect.skipIf(!symlinksSupported)(
      "refuses a file swapped for a symlink after it was located, and checks nothing further",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const workspace = yield* makeWorkspace();
          const tempRoot = yield* makeTempRoot;
          const tools = makeFakeMacTools({ version: VERSION });
          const { artifact, patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

          const outside = yield* fileSystem.makeTempDirectoryScoped();
          yield* fileSystem.writeFileString(path.join(outside, "evil.dmg"), "evil");
          yield* fileSystem.remove(artifact.dmgPath);
          yield* fileSystem.symlink(path.join(outside, "evil.dmg"), artifact.dmgPath);

          yield* run;

          expect(checkSummary(patches)[0]).toEqual(["sha256", "failed"]);
          expect(
            checkSummary(patches)
              .slice(1)
              .every(([, status]) => status === "not-run"),
          ).toBe(true);
          expect(patches.find((patch) => patch.artifact !== undefined)).toBeUndefined();
          expect(callNames(tools)).toEqual(["rm -rfx"]);
          expect(tools.calls[0]?.args).toEqual([
            "-rfx",
            "--",
            path.join(tempRoot, "t3v-attempt-test-1"),
          ]);
          expect(yield* fileSystem.readFileString(path.join(outside, "evil.dmg"))).toBe("evil");
        }),
    );
  });

  describe("removeOwnedRunDir", () => {
    const makeRunDir = (
      tempRoot: string,
      attemptId: string,
      marker: string | null,
      launchMarker = false,
    ) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runDir = path.join(tempRoot, `t3v-${attemptId}`);
        yield* fileSystem.makeDirectory(path.join(runDir, "mnt"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(runDir, "artifact.dmg"), "copy");
        if (marker !== null) {
          yield* fileSystem.writeFileString(path.join(runDir, ".t3-release-verify"), marker);
        }
        if (launchMarker) {
          yield* fileSystem.writeFileString(path.join(runDir, LAUNCH_UNCONFIRMED_MARKER), "x");
        }
        return runDir;
      });

    const remove = (
      tempRoot: string,
      attemptId: string,
      runDir: string | null,
      tools = makeFakeMacTools({ version: VERSION }),
    ) =>
      removeOwnedRunDir({ attemptId, runDir }, tempRoot, () => Effect.succeed(false)).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, tools.processRunner),
      );

    it.effect("removes a folder this feature made for that attempt", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempRoot = yield* makeTempRoot;
        const runDir = yield* makeRunDir(tempRoot, "attempt-a", "attempt-a");
        const tools = makeFakeMacTools({ version: VERSION });

        expect(yield* remove(tempRoot, "attempt-a", runDir, tools)).toBeNull();
        expect(tools.calls).toEqual([{ name: "rm", args: ["-rfx", "--", runDir] }]);
        expect(yield* fileSystem.exists(runDir)).toBe(false);
      }),
    );

    it.effect("leaves a folder with a different or missing marker, or the wrong place, alone", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempRoot = yield* makeTempRoot;
        const otherRoot = yield* makeTempRoot;
        const wrongMarker = yield* makeRunDir(tempRoot, "attempt-b", "someone-else");
        const noMarker = yield* makeRunDir(tempRoot, "attempt-c", null);
        const elsewhere = yield* makeRunDir(otherRoot, "attempt-d", "attempt-d");
        const unrelated = path.join(tempRoot, "unrelated");
        yield* fileSystem.makeDirectory(unrelated);
        const tools = makeFakeMacTools({ version: VERSION });

        expect(yield* remove(tempRoot, "attempt-b", wrongMarker, tools)).toContain(
          "ownership marker",
        );
        expect(yield* remove(tempRoot, "attempt-c", noMarker, tools)).toContain("ownership marker");
        const notOurs = "not one this server created";
        expect(yield* remove(tempRoot, "attempt-d", elsewhere, tools)).toContain(notOurs);
        expect(yield* remove(tempRoot, "attempt-e", unrelated, tools)).toContain(notOurs);
        expect(yield* remove(tempRoot, "../attempt", wrongMarker, tools)).toContain(notOurs);

        // The ownership checks come first: no `rm` was even started for any of them.
        expect(tools.calls).toEqual([]);
        for (const survivor of [wrongMarker, noMarker, elsewhere, unrelated]) {
          expect(yield* fileSystem.exists(survivor)).toBe(true);
        }
      }),
    );

    it.effect("treats a folder that is already gone as cleaned up", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION });

        expect(
          yield* remove(tempRoot, "attempt-f", path.join(tempRoot, "t3v-attempt-f"), tools),
        ).toBeNull();
        expect(tools.calls).toEqual([]);
      }),
    );

    it.effect("reports an owned folder that rm failed to remove, and keeps it", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempRoot = yield* makeTempRoot;
        // A failing exit, and an exit 0 that left the folder behind.
        const failures = [
          ["attempt-h", { rmExit: 1 }],
          ["attempt-i", { rmKeepsFolder: true }],
        ] as const;
        for (const [attemptId, failure] of failures) {
          const runDir = yield* makeRunDir(tempRoot, attemptId, attemptId);
          const tools = makeFakeMacTools({ version: VERSION, ...failure });

          const problem = yield* remove(tempRoot, attemptId, runDir, tools);

          expect(problem, attemptId).toBe("The temporary folder could not be deleted.");
          expect(tools.calls, attemptId).toEqual([{ name: "rm", args: ["-rfx", "--", runDir] }]);
          expect(yield* fileSystem.exists(runDir), attemptId).toBe(true);
        }
      }),
    );

    it.effect("refuses a folder with the launch marker before detaching or deleting", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempRoot = yield* makeTempRoot;
        // Owned by marker, and still "mounted" as far as the check goes: any cleanup would detach.
        const runDir = yield* makeRunDir(tempRoot, "attempt-g", "attempt-g", true);
        const tools = makeFakeMacTools({ version: VERSION });

        const problem = yield* removeOwnedRunDir({ attemptId: "attempt-g", runDir }, tempRoot, () =>
          Effect.succeed(true),
        ).pipe(Effect.provideService(ProcessRunner.ProcessRunner, tools.processRunner));

        expect(problem).toBe(LAUNCH_MAY_RUN_NOTE);
        expect(tools.calls).toEqual([]);
        expect(yield* fileSystem.exists(runDir)).toBe(true);
        expect(yield* fileSystem.exists(`${runDir}/${LAUNCH_UNCONFIRMED_MARKER}`)).toBe(true);
      }),
    );
  });

  describe("launch check", () => {
    const hereRunDir = (patches: ReadonlyArray<RunnerPatch>) => patches[0]?.runDir ?? "";

    it.effect("copies the mounted app, verifies the copy the same way, then launches it", () =>
      Effect.gen(function* () {
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        const runDir = hereRunDir(patches);
        const copy = `${runDir}/launch/OOP.app`;
        // One short folder holds everything: the launched app's sockets must fit in 103 bytes.
        expect(runDir).toBe(`${tempRoot}/t3v-attempt-test-1`);
        expect(Buffer.byteLength(runDir)).toBeLessThanOrEqual(54);

        const names = callNames(tools);
        expect(names.slice(4)).toEqual([
          "codesign --verify",
          "ditto",
          "codesign copy",
          "env osascript",
          "hdiutil detach",
          "rm -rfx",
        ]);
        const ditto = tools.calls.find((call) => call.name === "ditto");
        expect(ditto?.args).toEqual([`${runDir}/mnt/OOP.app`, copy]);

        // The copy is checked with exactly the flags the mounted app was.
        const signatures = tools.calls.filter((call) => call.name === "codesign");
        expect(signatures.map((call) => call.args.at(-1))).toEqual([`${runDir}/mnt/OOP.app`, copy]);
        expect(signatures[1]?.args.slice(0, -1)).toEqual(signatures[0]?.args.slice(0, -1));

        // The launcher is `env -u ELECTRON_RUN_AS_NODE /usr/bin/osascript ...`, given the copy and
        // an environment rooted in the same folder.
        const launcher = tools.calls.find((call) => call.name === "env");
        expect(launcher?.args.slice(0, 3)).toEqual([
          "-u",
          "ELECTRON_RUN_AS_NODE",
          "/usr/bin/osascript",
        ]);
        expect(launcher?.args[7]).toBe(copy);
        expect(launcher?.args[8]).toContain(`${runDir}/t3-home`);
        expect(launcher?.args[8]).toContain(`${runDir}/electron-user-data`);

        // Nothing started, so the fake launcher's setup error is a not-run and the folder is freed.
        const launch = latestChecks(patches).find((check) => check.id === "launch-smoke");
        expect(launch).toMatchObject({ status: "not-run", exitCode: null });
        expect(launch?.detail).toContain("Launcher setup failed");
        expect(tools.calls.some((call) => call.name === "ps" || call.name === "kill")).toBe(false);
        expect(patches.at(-1)).toEqual({ runDir: null });
      }),
    );

    it.effect("a failed copy never reaches the signature check or the launcher", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION, dittoExit: 1 });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        expect(callNames(tools).slice(4)).toEqual([
          "codesign --verify",
          "ditto",
          "hdiutil detach",
          "rm -rfx",
        ]);
        const launch = latestChecks(patches).find((check) => check.id === "launch-smoke");
        expect(launch).toMatchObject({ status: "not-run", exitCode: 1 });
        expect(launch?.detail).toContain("the app was not started");
        expect(yield* fileSystem.exists(hereRunDir(patches))).toBe(false);
      }),
    );

    it.effect("a copy failing the strict signature check is a failure and never starts", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const tools = makeFakeMacTools({ version: VERSION, copyCodesignExit: 1 });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        expect(callNames(tools).slice(4)).toEqual([
          "codesign --verify",
          "ditto",
          "codesign copy",
          "hdiutil detach",
          "rm -rfx",
        ]);
        const launch = latestChecks(patches).find((check) => check.id === "launch-smoke");
        expect(launch).toMatchObject({ status: "failed", exitCode: 1 });
        expect(launch?.tail).toEqual(["invalid signature"]);
        expect(yield* fileSystem.exists(hereRunDir(patches))).toBe(false);
      }),
    );

    it.effect("keeps the folder, and ends in an error, when a launch may still be running", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        // The helper cannot tell whether the app started, so it keeps its marker and its flag.
        const tools = makeFakeMacTools({ version: VERSION, launcher: "unusable" });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        yield* run;

        const runDir = hereRunDir(patches);
        // All six checks are still there, and the launch is neither a pass nor a failure.
        expect(checkSummary(patches).map(([id]) => id)).toEqual([
          "sha256",
          "image-verify",
          "mount-readonly",
          "app-bundle",
          "codesign-strict",
          "launch-smoke",
        ]);
        const launch = latestChecks(patches).find((check) => check.id === "launch-smoke");
        expect(launch?.status).toBe("timed-out");
        expect(launch?.detail).toContain("Cleanup not confirmed");

        // The image is unmounted, but the folder and its marker stay, with the reason recorded.
        expect(tools.state.mounted).toBe(false);
        expect(patches.at(-1)?.error).toContain(LAUNCH_MAY_RUN_NOTE);
        expect(patches.some((patch) => patch.runDir === null)).toBe(false);
        expect(yield* fileSystem.exists(`${runDir}/${LAUNCH_UNCONFIRMED_MARKER}`)).toBe(true);
        expect(yield* fileSystem.exists(`${runDir}/launch/OOP.app`)).toBe(true);
        // Nothing unidentified was signalled, and nothing was deleted.
        expect(tools.calls.some((call) => call.name === "ps" || call.name === "kill")).toBe(false);
        expect(callNames(tools)).not.toContain("rm -rfx");

        // Later cleanup refuses too, so a restart or retry cannot delete under a live app.
        const problem = yield* cleanupRunDir(runDir, tools.isMounted).pipe(
          Effect.provideService(ProcessRunner.ProcessRunner, tools.processRunner),
        );
        expect(problem).toBe(LAUNCH_MAY_RUN_NOTE);
        expect(callNames(tools)).not.toContain("rm -rfx");
        expect(yield* fileSystem.exists(runDir)).toBe(true);
        yield* fileSystem.remove(runDir, { recursive: true, force: true });
      }),
    );

    it.effect("on cancel, waits for the helper to stop the app before unmounting", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const workspace = yield* makeWorkspace();
        const tempRoot = yield* makeTempRoot;
        const watching = yield* Deferred.make<void>();
        const lists = { count: 0 };
        // The first listing identifies the app; the second is the proof wait watching it.
        const tools = makeFakeMacTools({
          version: VERSION,
          launcher: "started",
          onProcessList: Effect.suspend(() => {
            lists.count += 1;
            return lists.count === 2
              ? Deferred.succeed(watching, undefined).pipe(Effect.asVoid)
              : Effect.void;
          }),
        });
        const { patches, run } = yield* prepareRun(workspace.root, tempRoot, tools);

        const fiber = yield* run.pipe(Effect.forkChild);
        yield* Deferred.await(watching);
        expect(tools.state.appAlive).toBe(true);
        yield* Fiber.interrupt(fiber);

        // The app was stopped by its identified process id, and only then was the image
        // unmounted and the folder deleted.
        const names = callNames(tools);
        const stopped = names.findIndex((name) => name.startsWith("kill"));
        expect(names[stopped]).toBe("kill TERM");
        expect(tools.calls[stopped]?.args.at(-1)).toBe("424242");
        expect(stopped).toBeGreaterThan(names.indexOf("env osascript"));
        expect(names.indexOf("hdiutil detach")).toBeGreaterThan(stopped);
        expect(names.slice(-2)).toEqual(["hdiutil detach", "rm -rfx"]);
        expect(tools.state.appAlive).toBe(false);
        expect(tools.state.mounted).toBe(false);
        expect(yield* fileSystem.exists(hereRunDir(patches))).toBe(false);
        expect(patches.at(-1)).toEqual({ runDir: null });
        expect(checkSummary(patches).find(([id]) => id === "launch-smoke")?.[1]).toBe("running");
      }),
    );

    describe("toLaunchStep", () => {
      const result = (overrides: Partial<LaunchSmokeResult>): LaunchSmokeResult => ({
        status: "passed",
        detail: "Isolated start verified.",
        tail: ["trace: all three signals seen"],
        cleanupSucceeded: true,
        ...overrides,
      });

      it("passes only when cleanup was confirmed and the flag agrees", () => {
        expect(toLaunchStep(result({}), false)).toEqual({
          status: "passed",
          detail: "Isolated start verified.",
          exitCode: null,
          tail: ["trace: all three signals seen"],
        });
      });

      it("never passes with unconfirmed cleanup, no answer, or the flag still set", () => {
        const withoutAnswer: LaunchSmokeResult = { status: "passed", detail: "Started." };
        const cases: ReadonlyArray<readonly [LaunchSmokeResult, boolean]> = [
          [result({ cleanupSucceeded: false }), false],
          [withoutAnswer, false],
          [result({}), true],
          [result({ cleanupSucceeded: false }), true],
        ];
        for (const [helperResult, mayRun] of cases) {
          const mapped = toLaunchStep(helperResult, mayRun);
          // Not a pass, and not a failure either: nothing was observed failing.
          expect(mapped.status).toBe("not-run");
          expect(mapped.detail).toContain("not confirmed gone");
        }
      });

      it("keeps every other status and detail exactly as the helper reported them", () => {
        for (const status of ["failed", "timed-out", "not-run"] as const) {
          const helperResult = result({ status, detail: "why", cleanupSucceeded: false });
          expect(toLaunchStep(helperResult, true)).toMatchObject({
            status,
            detail: "why",
            exitCode: null,
          });
        }
      });
    });
  });
});
