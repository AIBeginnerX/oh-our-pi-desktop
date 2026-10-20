// @effect-diagnostics nodeBuiltinImport:off -- These tests exercise symlink, permission and hash behavior on real temporary folders.
import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as LocalPkgUpdates from "./LocalPkgUpdates.ts";
import * as LocalPkgSource from "./LocalPkgSource.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-local-pkg-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

const sha256Of = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");

const PKG_NAME = "OoP-0.0.50-arm64-update.pkg";

interface FakeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

interface FakeProcessResult {
  /** A promise models a child that exits only when the test lets it. */
  readonly exitCode: number | Promise<number>;
  readonly stdout?: string;
  readonly stderr?: string;
}

const encoder = new TextEncoder();

/**
 * A ChildProcessSpawner that runs nothing. The Command is projected to plain
 * `{ command, args }` before it reaches the handler, so tests compare argv
 * exactly instead of comparing an Effect-shaped object.
 */
const makeFakeSpawner = (handler: (command: FakeCommand) => FakeProcessResult) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((spawned) => {
      const { command, args } = spawned as unknown as FakeCommand;
      const result = handler({ command, args: [...args] });
      const exit = result.exitCode;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode:
            typeof exit === "number"
              ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
              : Effect.promise(() => exit).pipe(
                  Effect.map((code) => ChildProcessSpawner.ExitCode(code)),
                ),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: result.stdout ? Stream.make(encoder.encode(result.stdout)) : Stream.empty,
          stderr: result.stderr ? Stream.make(encoder.encode(result.stderr)) : Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const NO_QUARANTINE: FakeProcessResult = {
  exitCode: 1,
  stderr: "xattr: No such xattr: com.apple.quarantine",
};
const noQuarantineSpawner = makeFakeSpawner(() => NO_QUARANTINE);

/** Lets fibers reach the timers they register, and promise callbacks run, before the clock moves. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 20; i += 1) {
    yield* Effect.yieldNow;
    yield* Effect.promise(() => Promise.resolve());
  }
});

/** A receipt the test fakes complete, so tests wait on events rather than sleeping. */
const makeGate = <A = void>() => {
  let release!: (value: A) => void;
  const promise = new Promise<A>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const inProcessSource = LocalPkgSource.makeInProcessSourceForTests(NodeFSP);

const sourceWithQuarantine = (result: LocalPkgSource.QuarantineRead) =>
  LocalPkgSource.makeInProcessSourceForTests(NodeFSP, {
    readQuarantine: () => Effect.succeed(result),
  });

const validManifest = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  platform: "darwin",
  arch: "arm64",
  version: "0.0.50",
  pkg: PKG_NAME,
  size: 1234,
  sha256: "a".repeat(64),
  ...overrides,
});

const writeManifest = (directory: string, manifest: unknown) =>
  Effect.promise(() =>
    NodeFSP.writeFile(
      NodePath.join(directory, "oop-update.json"),
      typeof manifest === "string" ? manifest : encodeJson(manifest),
    ),
  );

const check = (
  sourceDirectory: string,
  currentVersion = "0.0.49",
  appArch: "arm64" | "x64" = "arm64",
) =>
  LocalPkgUpdates.checkLocalPackage({
    sourceDirectory,
    currentVersion,
    appArch,
    source: inProcessSource,
  });

/** The failure a check must produce, with the folder path kept out of the error. */
const checkFailure = Effect.fnUntraced(function* (
  sourceDirectory: string,
  currentVersion?: string,
  appArch?: "arm64" | "x64",
) {
  const error = yield* check(sourceDirectory, currentVersion, appArch).pipe(Effect.flip);
  assert.notInclude(error.message, sourceDirectory);
  assert.notInclude(encodeJson(error), sourceDirectory);
  return error;
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("LocalPkgUpdates.loadConfig", () => {
  it.effect("treats a missing config as absent and a valid one as ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resources = yield* tempDirectory;
        assert.equal((yield* LocalPkgUpdates.loadConfig(resources))._tag, "Absent");

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(resources, "oop-local-update.json"),
            encodeJson({ directory: "/Volumes/oop/release/macos" }),
          ),
        );
        const config = yield* LocalPkgUpdates.loadConfig(resources);
        assert.deepEqual(config, { _tag: "Ready", directories: ["/Volumes/oop/release/macos"] });

        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(resources, "oop-local-update.json"),
            encodeJson({
              directory: "/Volumes/oop/release/macos",
              connectUrl: "smb://192.168.0.10/oop",
            }),
          ),
        );
        assert.deepEqual(yield* LocalPkgUpdates.loadConfig(resources), {
          _tag: "Ready",
          directories: ["/Volumes/oop/release/macos"],
          connectUrl: "smb://192.168.0.10/oop",
        });

        // Google Drive candidates first, the old single folder last.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(resources, "oop-local-update.json"),
            encodeJson({
              directories: [
                "~/Library/CloudStorage/GoogleDrive-*/My Drive/OoP/release/macos",
                "~/Library/CloudStorage/GoogleDrive-*/내 드라이브/OoP/release/macos",
              ],
              directory: "/Volumes/oop/release/macos",
              folderKind: "google-drive",
            }),
          ),
        );
        assert.deepEqual(yield* LocalPkgUpdates.loadConfig(resources), {
          _tag: "Ready",
          directories: [
            "~/Library/CloudStorage/GoogleDrive-*/My Drive/OoP/release/macos",
            "~/Library/CloudStorage/GoogleDrive-*/내 드라이브/OoP/release/macos",
            "/Volumes/oop/release/macos",
          ],
          folderKind: "google-drive",
        });
      }),
    ),
  );

  it.effect("reports configs that cannot be trusted as invalid, never as absent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const resources = yield* tempDirectory;
        const configPath = NodePath.join(resources, "oop-local-update.json");
        const rejected = [
          "{not json",
          "{}",
          encodeJson({ directory: 7 }),
          encodeJson({ directory: "relative/folder" }),
          encodeJson({ directory: "/Volumes/oop/../etc" }),
          encodeJson({ directory: "/Volumes/oop", extra: true }),
          encodeJson({ directory: "/Volumes/o\u0000op" }),
          encodeJson({ directory: `/${"a".repeat(5000)}` }),
          encodeJson({ directory: "/Volumes/oop", connectUrl: "https://example.com/oop" }),
          encodeJson({ directory: "/Volumes/oop", connectUrl: "smb://user:secret@nas/oop" }),
          encodeJson({ directory: "/Volumes/oop", connectUrl: "not a url" }),
          encodeJson({ directories: [] }),
          encodeJson({ directories: ["relative/folder"] }),
          encodeJson({ directories: ["~/../etc"] }),
          encodeJson({ directories: ["/Volumes/a*b*c/release"] }),
          encodeJson({ directories: ["/Volumes/oop"], folderKind: "dropbox" }),
        ];
        for (const content of rejected) {
          yield* Effect.promise(() => NodeFSP.writeFile(configPath, content));
          const config = yield* LocalPkgUpdates.loadConfig(resources);
          assert.equal(config._tag, "Invalid", content.slice(0, 40));
          if (config._tag === "Invalid") assert.equal(config.error.reason, "config-invalid");
        }

        // A symlinked config is not read through.
        const real = NodePath.join(resources, "real.json");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(real, encodeJson({ directory: "/Volumes/oop" }));
          await NodeFSP.rm(configPath);
          await NodeFSP.symlink(real, configPath);
        });
        assert.equal((yield* LocalPkgUpdates.loadConfig(resources))._tag, "Invalid");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Manifest and version policy
// ---------------------------------------------------------------------------

describe("LocalPkgUpdates.parseStableVersion", () => {
  it("accepts only canonical stable versions of safe integers", () => {
    assert.deepEqual(Option.getOrNull(LocalPkgUpdates.parseStableVersion("0.0.50")), [0, 0, 50]);
    assert.deepEqual(
      Option.getOrNull(LocalPkgUpdates.parseStableVersion("10.20.30")),
      [10, 20, 30],
    );
    for (const version of [
      "",
      "1.2",
      "1.2.3.4",
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-beta.1",
      "1.2.3+build",
      "v1.2.3",
      " 1.2.3",
      "-1.2.3",
      "99999999999999999999.0.0",
    ]) {
      assert.isTrue(Option.isNone(LocalPkgUpdates.parseStableVersion(version)), version);
    }
  });
});

describe("LocalPkgUpdates.checkLocalPackage", () => {
  it.effect("offers only strictly newer versions, compared numerically", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        const offered = (manifestVersion: string, current: string) =>
          Effect.gen(function* () {
            yield* writeManifest(
              folder,
              validManifest({
                version: manifestVersion,
                pkg: `OoP-${manifestVersion}-arm64-update.pkg`,
              }),
            );
            return Option.isSome(yield* check(folder, current));
          });

        assert.isTrue(yield* offered("0.0.50", "0.0.49"));
        assert.isTrue(yield* offered("0.0.10", "0.0.9"));
        assert.isTrue(yield* offered("1.0.0", "0.99.99"));
        assert.isFalse(yield* offered("0.0.50", "0.0.50"));
        assert.isFalse(yield* offered("0.0.49", "0.0.50"));
        assert.isFalse(yield* offered("0.0.9", "0.0.10"));
        assert.isFalse(yield* offered("0.9.99", "1.0.0"));

        yield* writeManifest(folder, validManifest());
        const manifest = Option.getOrThrow(yield* check(folder));
        assert.equal(manifest.version, "0.0.50");
        assert.equal(manifest.pkg, PKG_NAME);
        assert.equal(manifest.size, 1234);
      }),
    ),
  );

  it.effect("accepts a package of exactly 1 GiB", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        yield* writeManifest(folder, validManifest({ size: 1024 * 1024 * 1024 }));
        assert.isTrue(Option.isSome(yield* check(folder)));
      }),
    ),
  );

  it.effect("offers a Windows setup only to the Windows app, under its exact name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        const checkWindows = LocalPkgUpdates.checkLocalPackage({
          sourceDirectory: folder,
          currentVersion: "0.0.49",
          appArch: "x64",
          platform: "win32",
          source: inProcessSource,
        });
        yield* writeManifest(
          folder,
          validManifest({ platform: "win32", arch: "x64", pkg: "OoP-0.0.50-x64.exe" }),
        );
        assert.equal(Option.getOrThrow(yield* checkWindows).pkg, "OoP-0.0.50-x64.exe");
        const onMac = yield* check(folder, "0.0.49", "x64").pipe(Effect.flip);
        assert.equal(onMac.reason, "manifest-unsupported");

        yield* writeManifest(
          folder,
          validManifest({ platform: "win32", arch: "x64", pkg: "OoP-0.0.50-x64-update.pkg" }),
        );
        assert.equal((yield* checkWindows.pipe(Effect.flip)).reason, "manifest-invalid");
      }),
    ),
  );

  it.effect("rejects manifests that are not exactly the published shape", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        const { sha256: _sha256, ...withoutHash } = validManifest();
        const cases: ReadonlyArray<readonly [string, unknown]> = [
          ["not json", "{not json"],
          ["truncated", '{"schemaVersion":1,'],
          ["a json array", "[]"],
          ["extra key", validManifest({ channel: "latest" })],
          ["missing sha256", withoutHash],
          ["schemaVersion 2", validManifest({ schemaVersion: 2 })],
          ["platform linux", validManifest({ platform: "linux" })],
          ["arch x64", validManifest({ arch: "x64" })],
          ["version with leading zero", validManifest({ version: "0.0.050" })],
          ["two-part version", validManifest({ version: "0.50" })],
          ["prerelease version", validManifest({ version: "0.0.50-beta.1" })],
          [
            "unsafe integer version",
            validManifest({
              version: "99999999999999999999.0.0",
              pkg: "OoP-99999999999999999999.0.0-arm64-update.pkg",
            }),
          ],
          ["pkg without arch", validManifest({ pkg: "OoP-0.0.50-update.pkg" })],
          ["pkg for another version", validManifest({ pkg: "OoP-0.0.51-arm64-update.pkg" })],
          ["pkg with parent path", validManifest({ pkg: `../${PKG_NAME}` })],
          ["pkg with subdirectory", validManifest({ pkg: `sub/${PKG_NAME}` })],
          ["absolute pkg path", validManifest({ pkg: `/tmp/${PKG_NAME}` })],
          ["size 0", validManifest({ size: 0 })],
          ["negative size", validManifest({ size: -1 })],
          ["fractional size", validManifest({ size: 1.5 })],
          ["size over 1 GiB", validManifest({ size: 1024 * 1024 * 1024 + 1 })],
          ["string size", validManifest({ size: "1234" })],
          ["uppercase hash", validManifest({ sha256: "A".repeat(64) })],
          ["short hash", validManifest({ sha256: "a".repeat(63) })],
          ["long hash", validManifest({ sha256: "a".repeat(65) })],
          ["non-hex hash", validManifest({ sha256: "g".repeat(64) })],
          ["manifest over 4 KiB", `${encodeJson(validManifest())}${" ".repeat(4096)}`],
        ];
        for (const [name, manifest] of cases) {
          yield* writeManifest(folder, manifest);
          const error = yield* checkFailure(folder);
          assert.equal(error.reason, "manifest-invalid", name);
        }
      }),
    ),
  );

  it.effect("does not read a manifest through a symlink or from a non-regular file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        const manifestPath = NodePath.join(folder, "oop-update.json");
        const real = NodePath.join(folder, "elsewhere.json");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(real, encodeJson(validManifest()));
          await NodeFSP.symlink(real, manifestPath);
        });
        assert.equal((yield* checkFailure(folder)).reason, "manifest-invalid");

        yield* Effect.promise(async () => {
          await NodeFSP.rm(manifestPath);
          await NodeFSP.mkdir(manifestPath);
        });
        assert.equal((yield* checkFailure(folder)).reason, "manifest-invalid");
      }),
    ),
  );

  it.effect("reports an unreadable folder without naming it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        assert.equal((yield* checkFailure(folder)).reason, "folder-unavailable");
        assert.equal(
          (yield* checkFailure(NodePath.join(folder, "unmounted-volume"))).reason,
          "folder-unavailable",
        );
      }),
    ),
  );

  it.effect("refuses a package for another architecture or an unversioned app", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        yield* writeManifest(folder, validManifest());
        assert.equal((yield* checkFailure(folder, "0.0.49", "x64")).reason, "manifest-unsupported");
        assert.equal((yield* checkFailure(folder, "0.0.49-nightly.5")).reason, "version-unknown");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

const sourceFixture = (content: string | Buffer = "OoP update package") =>
  Effect.gen(function* () {
    const root = yield* tempDirectory;
    const sourceDirectory = NodePath.join(root, "source");
    const bytes = typeof content === "string" ? Buffer.from(content) : content;
    const pkgPath = NodePath.join(sourceDirectory, PKG_NAME);
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(sourceDirectory);
      await NodeFSP.writeFile(pkgPath, bytes);
    });
    const manifest: LocalPkgUpdates.LocalPkgManifest = {
      schemaVersion: 1,
      platform: "darwin",
      arch: "arm64",
      version: "0.0.50",
      pkg: PKG_NAME,
      size: bytes.length,
      sha256: sha256Of(bytes),
    };
    return {
      root,
      sourceDirectory,
      pkgPath,
      bytes,
      manifest,
      stagingRoot: NodePath.join(root, "user-data", "oop-local-update"),
    };
  });

type SourceFixture = Effect.Success<ReturnType<typeof sourceFixture>>;

const stageFrom = (
  fixture: SourceFixture,
  options: {
    readonly fs?: LocalPkgUpdates.LocalPkgFs;
    readonly source?: LocalPkgSource.LocalPkgSource;
    readonly manifest?: LocalPkgUpdates.LocalPkgManifest;
    readonly onProgress?: (percent: number) => Effect.Effect<void>;
    readonly spawner?: ReturnType<typeof makeFakeSpawner>;
  } = {},
) =>
  LocalPkgUpdates.stage({
    sourceDirectory: fixture.sourceDirectory,
    stagingRoot: fixture.stagingRoot,
    manifest: options.manifest ?? fixture.manifest,
    ...(options.fs === undefined ? {} : { fs: options.fs }),
    source: options.source ?? inProcessSource,
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  }).pipe(Effect.provide(options.spawner ?? noQuarantineSpawner));

const listStaging = (stagingRoot: string) =>
  Effect.promise(() => NodeFSP.readdir(stagingRoot).catch(() => [] as Array<string>));

const permissionsOf = (path: string) =>
  Effect.promise(async () => (await NodeFSP.stat(path)).mode & 0o777);

/** Wraps only handles opened under `directory`; every other path stays real. */
const wrapHandlesUnder = (
  directory: string,
  wrap: (handle: NodeFSP.FileHandle) => unknown,
): LocalPkgUpdates.LocalPkgFs => ({
  ...NodeFSP,
  open: async (path, flags, mode) => {
    const handle = await NodeFSP.open(path, flags, mode);
    return String(path).startsWith(directory) ? (wrap(handle) as NodeFSP.FileHandle) : handle;
  },
});

/**
 * A source whose `open` is controlled by the test: it reports when it starts
 * and finishes only when released (with a real handle, or with a failure). The
 * handle it eventually yields reports its close, so the test can wait for the
 * receipt that a late handle was closed exactly once.
 */
const makeLateOpenFs = (sourceDirectory: string) => {
  const started = makeGate();
  const finish = makeGate<"handle" | "failure">();
  const closed = makeGate();
  const state = { opens: 0, closes: 0, handle: undefined as NodeFSP.FileHandle | undefined };
  const fs: LocalPkgUpdates.LocalPkgFs = {
    ...NodeFSP,
    open: async (path, flags, mode) => {
      if (!String(path).startsWith(sourceDirectory)) return NodeFSP.open(path, flags, mode);
      state.opens += 1;
      started.release();
      if ((await finish.promise) === "failure") {
        throw Object.assign(new Error("input/output error"), { code: "EIO" });
      }
      const handle = await NodeFSP.open(path, flags, mode);
      state.handle = handle;
      return {
        stat: () => handle.stat(),
        read: (buffer: Buffer, offset: number, length: number, position: null) =>
          handle.read(buffer, offset, length, position),
        close: async () => {
          state.closes += 1;
          closed.release();
          await handle.close();
        },
      } as unknown as NodeFSP.FileHandle;
    },
  };
  return { fs, started, finish, closed, state };
};

describe("LocalPkgUpdates.stage", () => {
  it.effect("copies into a private stage directory and verifies the staged file", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture("x".repeat(3 * 1024 * 1024 + 17));
        const progress: number[] = [];
        const staged = yield* stageFrom(fixture, {
          onProgress: (percent) =>
            Effect.sync(() => {
              progress.push(percent);
            }),
        });

        assert.equal(NodePath.dirname(staged.directory), fixture.stagingRoot);
        assert.isTrue(NodePath.basename(staged.directory).startsWith("stage-"));
        assert.equal(staged.path, NodePath.join(staged.directory, PKG_NAME));
        assert.equal(staged.version, "0.0.50");
        assert.equal(staged.sha256, fixture.manifest.sha256);
        assert.isTrue(
          Buffer.from(yield* Effect.promise(() => NodeFSP.readFile(staged.path))).equals(
            fixture.bytes,
          ),
        );
        assert.equal(yield* permissionsOf(staged.path), 0o600);
        assert.equal(yield* permissionsOf(staged.directory), 0o700);
        assert.equal(yield* permissionsOf(fixture.stagingRoot), 0o700);
        assert.deepEqual(yield* listStaging(staged.directory), [PKG_NAME]);

        assert.isAbove(progress.length, 1);
        assert.deepEqual(
          progress,
          [...progress].sort((a, b) => a - b),
        );
        assert.isTrue(progress.every((percent) => percent >= 0 && percent <= 99));

        yield* LocalPkgUpdates.verifyStaged(staged);
      }),
    ),
  );

  it.effect("gives every stage its own directory and leaves the previous one alone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const first = yield* stageFrom(fixture);
        const second = yield* stageFrom(fixture);
        assert.notEqual(first.directory, second.directory);
        yield* LocalPkgUpdates.verifyStaged(first);
        yield* LocalPkgUpdates.verifyStaged(second);
      }),
    ),
  );

  it.effect("tightens a staging folder that is looser than 0700", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(fixture.stagingRoot, { recursive: true });
          await NodeFSP.chmod(fixture.stagingRoot, 0o755);
        });
        yield* stageFrom(fixture);
        assert.equal(yield* permissionsOf(fixture.stagingRoot), 0o700);
      }),
    ),
  );

  it.effect("refuses a symlinked staging folder and writes nothing through it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const elsewhere = NodePath.join(fixture.root, "elsewhere");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(elsewhere);
          await NodeFSP.mkdir(NodePath.dirname(fixture.stagingRoot), { recursive: true });
          await NodeFSP.symlink(elsewhere, fixture.stagingRoot);
        });
        const error = yield* stageFrom(fixture).pipe(Effect.flip);
        assert.equal(error.reason, "staging-failed");
        assert.deepEqual(yield* listStaging(elsewhere), []);
      }),
    ),
  );

  it.effect("rejects a symlinked source package", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const real = NodePath.join(fixture.root, "real.pkg");
        yield* Effect.promise(async () => {
          await NodeFSP.rename(fixture.pkgPath, real);
          await NodeFSP.symlink(real, fixture.pkgPath);
        });
        const error = yield* stageFrom(fixture).pipe(Effect.flip);
        assert.equal(error.reason, "package-mismatch");
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
      }),
    ),
  );

  it.effect("rejects a missing or non-regular source package", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        yield* Effect.promise(() => NodeFSP.rm(fixture.pkgPath));
        assert.equal((yield* stageFrom(fixture).pipe(Effect.flip)).reason, "package-mismatch");
        yield* Effect.promise(() => NodeFSP.mkdir(fixture.pkgPath));
        assert.equal((yield* stageFrom(fixture).pipe(Effect.flip)).reason, "package-mismatch");
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
      }),
    ),
  );

  it.effect("leaves no stage directory when the content does not match the manifest hash", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        // Same size, different bytes: only the hash can tell.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(fixture.pkgPath, Buffer.alloc(fixture.bytes.length, 1)),
        );
        const error = yield* stageFrom(fixture).pipe(Effect.flip);
        assert.equal(error.reason, "package-mismatch");
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
      }),
    ),
  );

  it.effect("rejects a source whose size differs from the manifest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        for (const content of [
          fixture.bytes.subarray(1),
          Buffer.concat([fixture.bytes, Buffer.from("!")]),
        ]) {
          yield* Effect.promise(() => NodeFSP.writeFile(fixture.pkgPath, content));
          const error = yield* stageFrom(fixture).pipe(Effect.flip);
          assert.equal(error.reason, "package-mismatch");
        }
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
      }),
    ),
  );

  it.effect("stops reading as soon as more bytes arrive than the manifest declares", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture("a source that keeps delivering bytes");
        const requested: number[] = [];
        const fs = wrapHandlesUnder(fixture.sourceDirectory, (handle) => ({
          // The source claims the declared size but streams past it.
          stat: async () => ({ isFile: () => true, size: 10 }),
          read: (buffer: Buffer, offset: number, length: number, position: null) => {
            requested.push(length);
            return handle.read(buffer, offset, length, position);
          },
          close: () => handle.close(),
        }));
        const error = yield* stageFrom(fixture, {
          source: LocalPkgSource.makeInProcessSourceForTests(fs),
          manifest: { ...fixture.manifest, size: 10 },
        }).pipe(Effect.flip);

        assert.equal(error.reason, "package-mismatch");
        // Declared size plus the one extra byte that exposes the overrun.
        assert.deepEqual(requested, [11]);
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
      }),
    ),
  );

  it.effect("fails a write that makes no progress instead of spinning", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const fs = wrapHandlesUnder(fixture.stagingRoot, (handle) => ({
          write: async (buffer: Buffer) => ({ bytesWritten: 0, buffer }),
          sync: () => handle.sync(),
          close: () => handle.close(),
        }));

        const error = yield* stageFrom(fixture, { fs }).pipe(Effect.flip);
        assert.equal(error.reason, "staging-failed");
        assert.equal(error.code, "EIO");
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
      }),
    ),
  );

  it.effect("copies the source quarantine flag with explicit argv and no shell", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const commands: FakeCommand[] = [];
        const quarantine = "0083;5f3a1b2c;Safari;8A6B1F44-0C1E-4B53-9D55-0D2E5A1C77AA";
        const staged = yield* stageFrom(fixture, {
          source: sourceWithQuarantine({ exitCode: 0, stdout: `${quarantine}\n`, stderr: "" }),
          spawner: makeFakeSpawner((command) => {
            commands.push(command);
            return { exitCode: 0 };
          }),
        });

        assert.deepEqual(commands, [
          {
            command: "/usr/bin/xattr",
            args: ["-w", "com.apple.quarantine", quarantine, staged.path],
          },
        ]);
      }),
    ),
  );

  it.effect("writes no quarantine flag when the source has none or cannot hold one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        for (const stderr of [
          "xattr: No such xattr: com.apple.quarantine",
          "xattr: [Errno 45] Operation not supported: 'x.pkg'",
        ]) {
          const commands: FakeCommand[] = [];
          yield* stageFrom(fixture, {
            source: sourceWithQuarantine({ exitCode: 1, stdout: "", stderr }),
            spawner: makeFakeSpawner((command) => {
              commands.push(command);
              return { exitCode: 1, stderr };
            }),
          });
          assert.deepEqual(commands, []);
        }
      }),
    ),
  );

  it.effect("aborts staging rather than dropping a quarantine flag it could not copy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const attempts: ReadonlyArray<
          readonly [string, LocalPkgSource.QuarantineRead, FakeProcessResult]
        > = [
          [
            "unreadable attribute",
            { exitCode: 1, stdout: "", stderr: "xattr: [Errno 5] Input/output error" },
            { exitCode: 0 },
          ],
          ["option-like value", { exitCode: 0, stdout: "-n evil\n", stderr: "" }, { exitCode: 0 }],
          [
            "control characters",
            { exitCode: 0, stdout: "0083;\u0001\n", stderr: "" },
            { exitCode: 0 },
          ],
          [
            "failed write",
            { exitCode: 0, stdout: "0083;5f3a;Safari;UUID\n", stderr: "" },
            { exitCode: 1, stderr: "xattr: [Errno 13] Permission denied" },
          ],
        ];
        for (const [name, read, write] of attempts) {
          const error = yield* stageFrom(fixture, {
            source: sourceWithQuarantine(read),
            spawner: makeFakeSpawner(() => write),
          }).pipe(Effect.flip);
          assert.equal(error.reason, "staging-failed", name);
          assert.deepEqual(yield* listStaging(fixture.stagingRoot), [], name);
        }
      }),
    ),
  );
});

const withTestClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect.pipe(Effect.provide(TestClock.layer())));

/**
 * Forks a stage, waits for the receipt that the fake folder stalled it, then
 * moves the clock past the source timeout and the close grace.
 */
const expireStage = Effect.fnUntraced(function* (
  fixture: SourceFixture,
  options: Parameters<typeof stageFrom>[1],
  stalled: Promise<void>,
) {
  const fiber = yield* stageFrom(fixture, options).pipe(Effect.flip, Effect.forkChild);
  yield* Effect.promise(() => stalled);
  yield* settle;
  yield* TestClock.adjust(Duration.seconds(30));
  yield* settle;
  yield* TestClock.adjust(Duration.seconds(2));
  return yield* Fiber.join(fiber);
});

// The in-process source is a test seam for individual filesystem failures. It
// retains bounded callers and late-handle cleanup, but it cannot kill a blocked
// syscall; real-child timeout and exit behavior is covered in LocalPkgSource.test.ts.
describe("LocalPkgUpdates with a stalled in-process test source", () => {
  it.effect("times out a stalled open and closes a late handle exactly once", () =>
    withTestClock(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const late = makeLateOpenFs(fixture.sourceDirectory);
        const source = LocalPkgSource.makeInProcessSourceForTests(late.fs);
        const error = yield* expireStage(fixture, { source }, late.started.promise);
        assert.equal(error.reason, "source-timeout");
        assert.notInclude(error.message, fixture.sourceDirectory);
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
        late.finish.release("handle");
        yield* Effect.promise(() => late.closed.promise);
        assert.equal(late.state.closes, 1);
        assert.equal(late.state.handle?.fd, -1);
        yield* stageFrom(fixture);
      }),
    ),
  );

  it.effect("times out a stalled manifest open and closes its late handle", () =>
    withTestClock(
      Effect.gen(function* () {
        const folder = yield* tempDirectory;
        yield* writeManifest(folder, validManifest());
        const late = makeLateOpenFs(folder);
        const source = LocalPkgSource.makeInProcessSourceForTests(late.fs);
        const checkWith = LocalPkgUpdates.checkLocalPackage({
          sourceDirectory: folder,
          currentVersion: "0.0.49",
          appArch: "arm64",
          source,
        });
        const fiber = yield* checkWith.pipe(Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => late.started.promise);
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(30));
        yield* settle;
        yield* TestClock.adjust(Duration.seconds(2));
        assert.equal((yield* Fiber.join(fiber)).reason, "source-timeout");
        late.finish.release("handle");
        yield* Effect.promise(() => late.closed.promise);
        assert.equal(late.state.closes, 1);
        assert.isTrue(Option.isSome(yield* check(folder)));
      }),
    ),
  );

  it.effect("bounds a stalled read and cleans the partial stage", () =>
    withTestClock(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const readStarted = makeGate();
        const readMayFinish = makeGate();
        const fs = wrapHandlesUnder(fixture.sourceDirectory, (handle) => ({
          stat: () => handle.stat(),
          read: async (buffer: Buffer, offset: number, length: number, position: null) => {
            readStarted.release();
            await readMayFinish.promise;
            return handle.read(buffer, offset, length, position);
          },
          close: async () => {
            await readMayFinish.promise;
            await handle.close();
          },
        }));
        const source = LocalPkgSource.makeInProcessSourceForTests(fs);
        const error = yield* expireStage(fixture, { source }, readStarted.promise);
        assert.equal(error.reason, "source-timeout");
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), []);
        readMayFinish.release();
        yield* stageFrom(fixture);
      }),
    ),
  );
});

describe("LocalPkgUpdates.removeStagedPackage", () => {
  it.effect("removes only the stage directory it created under the staging root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* sourceFixture();
        const staged = yield* stageFrom(fixture);

        // Directories outside the staging root, or without the stage prefix,
        // are never touched even if a staged record points at them.
        const outside = NodePath.join(fixture.root, "outside");
        const unprefixed = NodePath.join(fixture.stagingRoot, "keep-me");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(outside);
          await NodeFSP.mkdir(unprefixed);
        });
        for (const directory of [outside, unprefixed, fixture.sourceDirectory]) {
          yield* LocalPkgUpdates.removeStagedPackage({
            stagingRoot: fixture.stagingRoot,
            staged: { ...staged, directory },
          });
        }
        assert.isTrue(
          (yield* Effect.promise(() => NodeFSP.readdir(fixture.sourceDirectory))).includes(
            PKG_NAME,
          ),
        );
        assert.deepEqual(
          [...(yield* listStaging(fixture.stagingRoot))].sort(),
          ["keep-me", NodePath.basename(staged.directory)].sort(),
        );
        yield* Effect.promise(() => NodeFSP.stat(outside));

        yield* LocalPkgUpdates.removeStagedPackage({ stagingRoot: fixture.stagingRoot, staged });
        assert.deepEqual(yield* listStaging(fixture.stagingRoot), ["keep-me"]);
      }),
    ),
  );
});

describe("LocalPkgUpdates.verifyStaged", () => {
  const tamperings: ReadonlyArray<
    readonly [string, (staged: LocalPkgUpdates.StagedPkg, root: string) => Promise<void>]
  > = [
    [
      "flipped byte of the same size",
      async (staged) => {
        const bytes = await NodeFSP.readFile(staged.path);
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        await NodeFSP.writeFile(staged.path, bytes);
      },
    ],
    ["truncated file", (staged) => NodeFSP.truncate(staged.path, staged.size - 1)],
    ["appended bytes", (staged) => NodeFSP.appendFile(staged.path, "!")],
    ["deleted file", (staged) => NodeFSP.rm(staged.path)],
    ["loosened permissions", (staged) => NodeFSP.chmod(staged.path, 0o644)],
    [
      "replaced by a symlink to identical bytes",
      async (staged, root) => {
        const copy = NodePath.join(root, "identical.pkg");
        await NodeFSP.copyFile(staged.path, copy);
        await NodeFSP.rm(staged.path);
        await NodeFSP.symlink(copy, staged.path);
      },
    ],
    [
      "replaced by a directory",
      async (staged) => {
        await NodeFSP.rm(staged.path);
        await NodeFSP.mkdir(staged.path);
      },
    ],
  ];

  for (const [name, tamper] of tamperings) {
    it.effect(`reports a staged file that changed on disk: ${name}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* sourceFixture();
          const staged = yield* stageFrom(fixture);
          yield* LocalPkgUpdates.verifyStaged(staged);

          yield* Effect.promise(() => tamper(staged, fixture.root));
          const error = yield* LocalPkgUpdates.verifyStaged(staged).pipe(Effect.flip);
          assert.equal(error.reason, "staged-changed");
          assert.notInclude(error.message, fixture.root);
        }),
      ),
    );
  }
});

// ---------------------------------------------------------------------------
// Installer handoff
// ---------------------------------------------------------------------------

describe("LocalPkgUpdates.openInstaller", () => {
  it.effect("opens exactly the macOS Installer on the staged package", () => {
    const commands: FakeCommand[] = [];
    return LocalPkgUpdates.openInstaller("/staging/stage-abc/OoP.pkg").pipe(
      Effect.provide(
        makeFakeSpawner((command) => {
          commands.push(command);
          return { exitCode: 0 };
        }),
      ),
      Effect.andThen(
        Effect.sync(() => {
          assert.deepEqual(commands, [
            {
              command: "/usr/bin/open",
              args: ["-b", "com.apple.installer", "/staging/stage-abc/OoP.pkg"],
            },
          ]);
        }),
      ),
    );
  });

  it.effect("fails with the exit status, not the path, when open refuses", () =>
    Effect.gen(function* () {
      const error = yield* LocalPkgUpdates.openInstaller("/staging/stage-abc/OoP.pkg").pipe(
        Effect.provide(makeFakeSpawner(() => ({ exitCode: 1 }))),
        Effect.flip,
      );
      assert.equal(error.reason, "installer-failed");
      assert.equal(error.code, "exit-1");
      assert.notInclude(error.message, "/staging");
    }),
  );

  it.effect("fails when open does not return in time", () =>
    Effect.gen(function* () {
      const fiber = yield* LocalPkgUpdates.openInstaller("/staging/stage-abc/OoP.pkg").pipe(
        Effect.provide(makeFakeSpawner(() => ({ exitCode: new Promise<number>(() => {}) }))),
        Effect.flip,
        Effect.forkChild,
      );
      yield* settle;
      yield* TestClock.adjust(Duration.seconds(11));
      assert.equal((yield* Fiber.join(fiber)).reason, "installer-failed");
    }).pipe(Effect.provide(TestClock.layer())),
  );
});

// ---------------------------------------------------------------------------
// Candidate folders (Google Drive, a per-device override, the old share)
// ---------------------------------------------------------------------------

describe("LocalPkgUpdates update folder candidates", () => {
  it.effect("expands the home folder and the account segment of a Google Drive root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const home = yield* tempDirectory;
        const cloud = NodePath.join(home, "Library", "CloudStorage");
        // A Korean Mac names the Drive root "내 드라이브"; one account, plus an unrelated provider.
        const drive = NodePath.join(
          cloud,
          "GoogleDrive-me@example.com",
          "내 드라이브",
          "OoP",
          "release",
          "macos",
        );
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(drive, { recursive: true });
          await NodeFSP.mkdir(NodePath.join(cloud, "Dropbox"), { recursive: true });
        });
        const expanded = yield* LocalPkgUpdates.expandUpdateDirectories(
          [
            "~/Library/CloudStorage/GoogleDrive-*/My Drive/OoP/release/macos",
            "~/Library/CloudStorage/GoogleDrive-*/내 드라이브/OoP/release/macos",
            "/Volumes/oop/release/macos",
          ],
          { home },
        );
        assert.deepEqual(expanded, [
          NodePath.join(cloud, "GoogleDrive-me@example.com", "My Drive", "OoP", "release", "macos"),
          drive,
          "/Volumes/oop/release/macos",
        ]);
        // No Drive installed: the Drive patterns expand to nothing, the share stays.
        assert.deepEqual(
          yield* LocalPkgUpdates.expandUpdateDirectories(
            ["~/Library/CloudStorage/GoogleDrive-*/My Drive/OoP/release/macos", "/Volumes/oop"],
            { home: NodePath.join(home, "nobody") },
          ),
          ["/Volumes/oop"],
        );
      }),
    ),
  );

  it.effect("checks the first folder that answers and remembers which one it was", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempDirectory;
        const missing = NodePath.join(root, "drive-not-synced");
        const share = NodePath.join(root, "share");
        yield* Effect.promise(() => NodeFSP.mkdir(share));
        yield* writeManifest(share, validManifest());
        const checked = yield* LocalPkgUpdates.checkLocalPackageIn({
          sourceDirectories: [missing, share],
          folderKind: "google-drive",
          currentVersion: "0.0.49",
          appArch: "arm64",
          source: inProcessSource,
        });
        assert.equal(checked.sourceDirectory, share);
        assert.equal(Option.getOrUndefined(checked.offered)?.version, "0.0.50");
      }),
    ),
  );

  it.effect("stops at the folder that answered with a bad manifest", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempDirectory;
        const broken = NodePath.join(root, "broken");
        const good = NodePath.join(root, "good");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(broken);
          await NodeFSP.mkdir(good);
        });
        yield* writeManifest(broken, "{not json");
        yield* writeManifest(good, validManifest());
        const error = yield* Effect.flip(
          LocalPkgUpdates.checkLocalPackageIn({
            sourceDirectories: [broken, good],
            currentVersion: "0.0.49",
            appArch: "arm64",
            source: inProcessSource,
          }),
        );
        assert.equal(error.reason, "manifest-invalid");
      }),
    ),
  );

  it.effect("says how to set up Google Drive when no candidate is there", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* tempDirectory;
        const candidates = [NodePath.join(root, "a"), NodePath.join(root, "b")];
        const drive = yield* Effect.flip(
          LocalPkgUpdates.checkLocalPackageIn({
            sourceDirectories: candidates,
            folderKind: "google-drive",
            currentVersion: "0.0.49",
            appArch: "arm64",
            source: inProcessSource,
          }),
        );
        assert.equal(drive.reason, "drive-folder-unavailable");
        assert.include(drive.message, "Google Drive");
        assert.notInclude(drive.message, root);
        const share = yield* Effect.flip(
          LocalPkgUpdates.checkLocalPackageIn({
            sourceDirectories: candidates,
            currentVersion: "0.0.49",
            appArch: "arm64",
            source: inProcessSource,
          }),
        );
        assert.equal(share.reason, "folder-unavailable");
      }),
    ),
  );

  it.effect("reads a per-device folder override and ignores one it cannot trust", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const userData = yield* tempDirectory;
        const overridePath = NodePath.join(userData, LocalPkgUpdates.FOLDER_OVERRIDE_FILE_NAME);
        assert.equal(yield* LocalPkgUpdates.readFolderOverride(userData), undefined);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            overridePath,
            encodeJson({ directory: "/Volumes/Drive/OoP/release/macos" }),
          ),
        );
        assert.equal(
          yield* LocalPkgUpdates.readFolderOverride(userData),
          "/Volumes/Drive/OoP/release/macos",
        );
        for (const content of [
          "{not json",
          encodeJson({ directory: "relative" }),
          encodeJson({ directory: "/a/*/b" }),
          encodeJson({ directory: "/a", extra: 1 }),
        ]) {
          yield* Effect.promise(() => NodeFSP.writeFile(overridePath, content));
          assert.equal(yield* LocalPkgUpdates.readFolderOverride(userData), undefined, content);
        }
      }),
    ),
  );
});
