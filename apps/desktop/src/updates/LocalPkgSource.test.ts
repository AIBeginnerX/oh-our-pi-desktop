// @effect-diagnostics nodeBuiltinImport:off -- These tests run real child processes against temporary source files.
import { assert, describe, it } from "@effect/vitest";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as LocalPkgSource from "./LocalPkgSource.ts";
import * as LocalPkgUpdates from "./LocalPkgUpdates.ts";

const tempDirectory = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "oop-pkg-source-"))),
  (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const noWriteSpawner = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die(new Error("unexpected local xattr write"))),
);

const workerCommand = {
  command: process.execPath,
  args: [
    "--experimental-strip-types",
    NodePath.join(import.meta.dirname, "LocalPkgSourceWorker.ts"),
  ],
};

const reasons = {
  unsafe: "manifest-invalid" as const,
  unreadable: "folder-unavailable" as const,
};

const noQuarantine = Effect.succeed({
  exitCode: 1,
  stdout: "",
  stderr: "xattr: No such xattr: com.apple.quarantine",
});

const manifestFor = (bytes: Buffer): LocalPkgUpdates.LocalPkgManifest => ({
  schemaVersion: 1,
  platform: "darwin",
  arch: "arm64",
  version: "0.0.50",
  pkg: "OoP-0.0.50-arm64-update.pkg",
  size: bytes.length,
  sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
});

/** Record an actual child `exit` before the source can send its first request. */
const recordSpawns = () => {
  const children: Array<{ readonly pid: number | undefined; readonly exited: Promise<void> }> = [];
  const spawn = ((
    command: string,
    args: ReadonlyArray<string>,
    options: NodeChildProcess.SpawnOptions,
  ) => {
    const child = NodeChildProcess.spawn(command, [...args], options);
    children.push({
      pid: child.pid,
      exited: new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      }),
    });
    return child;
  }) as typeof NodeChildProcess.spawn;
  return { spawn, children };
};

const writeWorker = (directory: string, body: string) =>
  Effect.promise(async () => {
    const path = NodePath.join(directory, "test-worker.cjs");
    await NodeFSP.writeFile(path, body);
    return path;
  });

const frameWorker = String.raw`
const mode = process.argv[2];
const frameBytes = (type, payload) => {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};
const frame = (type, payload) => process.stdout.write(frameBytes(type, payload));
let requests = 0;
process.stdin.on('data', () => {
  requests += 1;
  if (mode === 'early-exit') return process.exit(0);
  if (mode === 'oversized') {
    const header = Buffer.alloc(5);
    header.writeUInt8(1, 0);
    header.writeUInt32BE(257, 1);
    return process.stdout.write(header);
  }
  if (mode === 'garbage') return process.stdout.write(frameBytes(255, Buffer.alloc(0)));
  if (mode === 'invalid-code') return frame(3, Buffer.from('{"code":"E/secret"}'));
  if (requests === 1) {
    if (mode === 'unsolicited') return process.stdout.write(Buffer.concat([
      frameBytes(1, Buffer.from('{}')),
      frameBytes(1, Buffer.from('{}')),
    ]));
    frame(1, Buffer.from('{}'));
    return;
  }
  if (mode === 'excess-data') return frame(2, Buffer.from('too many bytes'));
});
`;

describe("LocalPkgSource child helper", () => {
  it("answers Windows drive and UNC paths instead of exiting", () => {
    // Windows update folders live on a share (\\host\share\...) or a drive; the helper must
    // try to open them rather than reject the request as malformed.
    for (const path of [
      "\\\\nas\\share\\release\\windows\\oop-update.json",
      "C:\\OoP\\release\\windows\\oop-update.json",
    ]) {
      const result = NodeChildProcess.spawnSync(workerCommand.command, workerCommand.args, {
        input: `${encodeJson({ op: "open", path })}\n`,
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
      assert.equal(result.status, 0);
      assert.equal(result.stdout.readUInt8(0), 3);
      assert.deepEqual(JSON.parse(result.stdout.subarray(5).toString("utf8")), {
        code: "ENOENT",
      });
    }
  });

  it.effect("bounds a dribbling manifest by the whole-Check deadline", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secondRead = yield* Deferred.make<void>();
        let reads = 0;
        const source: LocalPkgSource.LocalPkgSource = {
          open: () =>
            Effect.succeed({
              stat: Effect.succeed({ isFile: true, size: 100 }),
              read: () =>
                Effect.gen(function* () {
                  reads += 1;
                  if (reads === 2) yield* Deferred.succeed(secondRead, undefined);
                  yield* Effect.sleep(Duration.seconds(20));
                  return Uint8Array.of(0x7b);
                }),
            }),
          readQuarantine: () => noQuarantine,
        };
        const checking = yield* LocalPkgUpdates.checkLocalPackage({
          sourceDirectory: "/private/test-update",
          currentVersion: "0.0.49",
          appArch: "arm64",
          source,
        }).pipe(Effect.flip, Effect.forkChild);
        yield* TestClock.adjust(Duration.seconds(20));
        yield* Deferred.await(secondRead);
        yield* TestClock.adjust(Duration.seconds(11));
        assert.equal((yield* Fiber.join(checking)).reason, "source-timeout");
        assert.equal(reads, 2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("checks, stages and verifies a package through the real helper", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const sourceDirectory = NodePath.join(directory, "published");
        const stagingRoot = NodePath.join(directory, "private-stage");
        const bytes = Buffer.from("real package content");
        const manifest = manifestFor(bytes);
        const packagePath = NodePath.join(sourceDirectory, manifest.pkg);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sourceDirectory);
          await NodeFSP.writeFile(packagePath, bytes);
          await NodeFSP.writeFile(
            NodePath.join(sourceDirectory, "oop-update.json"),
            encodeJson(manifest),
          );
        });
        const real = LocalPkgSource.makeChildProcessSource({ workerCommand });
        const source = { ...real, readQuarantine: () => noQuarantine };
        const offer = yield* LocalPkgUpdates.checkLocalPackage({
          sourceDirectory,
          currentVersion: "0.0.49",
          appArch: "arm64",
          source,
        });
        assert.isTrue(Option.isSome(offer));
        const staged = yield* LocalPkgUpdates.stage({
          sourceDirectory,
          stagingRoot,
          manifest,
          source,
        }).pipe(Effect.provide(noWriteSpawner));
        yield* LocalPkgUpdates.verifyStaged(staged);
        assert.equal(
          Buffer.from(yield* Effect.promise(() => NodeFSP.readFile(staged.path))).toString(),
          bytes.toString(),
        );

        // A same-sized replacement must fail the hash check and leave the good stage alone.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(packagePath, Buffer.alloc(bytes.length, 0x78)),
        );
        const mismatch = yield* LocalPkgUpdates.stage({
          sourceDirectory,
          stagingRoot,
          manifest,
          source,
        }).pipe(Effect.provide(noWriteSpawner), Effect.flip);
        assert.equal(mismatch.reason, "package-mismatch");
        assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(stagingRoot)), [
          NodePath.basename(staged.directory),
        ]);
      }),
    ),
  );

  it.live(
    "rejects real-helper source symlinks, directories, oversized manifest and package size changes",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* tempDirectory;
          const sourceDirectory = NodePath.join(directory, "published");
          const stagingRoot = NodePath.join(directory, "private-stage");
          const bytes = Buffer.from("published package");
          const manifest = manifestFor(bytes);
          const manifestPath = NodePath.join(sourceDirectory, "oop-update.json");
          const packagePath = NodePath.join(sourceDirectory, manifest.pkg);
          yield* Effect.promise(async () => {
            await NodeFSP.mkdir(sourceDirectory);
            await NodeFSP.writeFile(packagePath, bytes);
            await NodeFSP.writeFile(manifestPath, encodeJson(manifest));
          });
          const real = LocalPkgSource.makeChildProcessSource({ workerCommand });
          const source = { ...real, readQuarantine: () => noQuarantine };
          const check = () =>
            LocalPkgUpdates.checkLocalPackage({
              sourceDirectory,
              currentVersion: "0.0.49",
              appArch: "arm64",
              source,
            });
          const stage = () =>
            LocalPkgUpdates.stage({ sourceDirectory, stagingRoot, manifest, source }).pipe(
              Effect.provide(noWriteSpawner),
            );
          const safe = (error: LocalPkgUpdates.LocalPkgUpdateError) => {
            assert.notInclude(error.message, directory);
            assert.notInclude(error.code ?? "", directory);
          };

          const realManifest = NodePath.join(directory, "real-manifest.json");
          yield* Effect.promise(async () => {
            await NodeFSP.rename(manifestPath, realManifest);
            await NodeFSP.symlink(realManifest, manifestPath);
          });
          const symlinkManifest = yield* check().pipe(Effect.flip);
          assert.equal(symlinkManifest.reason, "manifest-invalid");
          safe(symlinkManifest);

          yield* Effect.promise(async () => {
            await NodeFSP.rm(manifestPath);
            await NodeFSP.mkdir(manifestPath);
          });
          const directoryManifest = yield* check().pipe(Effect.flip);
          assert.equal(directoryManifest.reason, "manifest-invalid");
          safe(directoryManifest);

          yield* Effect.promise(async () => {
            await NodeFSP.rm(manifestPath, { recursive: true });
            await NodeFSP.writeFile(manifestPath, " ".repeat(4097));
          });
          const oversizedManifest = yield* check().pipe(Effect.flip);
          assert.equal(oversizedManifest.reason, "manifest-invalid");
          safe(oversizedManifest);

          const realPackage = NodePath.join(directory, "real.pkg");
          yield* Effect.promise(async () => {
            await NodeFSP.rename(packagePath, realPackage);
            await NodeFSP.symlink(realPackage, packagePath);
          });
          const symlinkPackage = yield* stage().pipe(Effect.flip);
          assert.equal(symlinkPackage.reason, "package-mismatch");
          safe(symlinkPackage);

          yield* Effect.promise(async () => {
            await NodeFSP.rm(packagePath);
            await NodeFSP.mkdir(packagePath);
          });
          const directoryPackage = yield* stage().pipe(Effect.flip);
          assert.equal(directoryPackage.reason, "package-mismatch");
          safe(directoryPackage);

          yield* Effect.promise(async () => {
            await NodeFSP.rm(packagePath, { recursive: true });
            await NodeFSP.writeFile(packagePath, Buffer.concat([bytes, Buffer.from("!")]));
          });
          const oversizedPackage = yield* stage().pipe(Effect.flip);
          assert.equal(oversizedPackage.reason, "package-mismatch");
          safe(oversizedPackage);
          assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(stagingRoot)), []);
        }),
      ),
  );

  it.live("reads a real file and rejects a symlink without exposing its path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const sourcePath = NodePath.join(directory, "source.json");
        const linkPath = NodePath.join(directory, "link.json");
        yield* Effect.promise(async () => {
          await NodeFSP.writeFile(sourcePath, "real helper bytes");
          await NodeFSP.symlink(sourcePath, linkPath);
        });
        const source = LocalPkgSource.makeChildProcessSource({ workerCommand });
        const bytes = yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* source.open(sourcePath, reasons);
            assert.deepEqual(yield* handle.stat, { isFile: true, size: 17 });
            return yield* handle.read(17);
          }),
        );
        assert.equal(Buffer.from(bytes).toString(), "real helper bytes");

        const error = yield* Effect.scoped(source.open(linkPath, reasons)).pipe(Effect.flip);
        assert.equal(error.reason, "manifest-invalid");
        assert.notInclude(error.message, directory);
        assert.notInclude(error.code ?? "", directory);
        assert.equal(LocalPkgSource.killedSourceHelpers(), 0);
      }),
    ),
  );

  it.live("kills a hanging real worker, then retires it on the recorded exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const receipt = NodePath.join(directory, "worker.pid");
        const worker = yield* writeWorker(
          directory,
          String.raw`const fs = require('node:fs'); fs.writeFileSync(process.argv[2], String(process.pid)); process.on('SIGTERM', () => {}); process.stdin.resume(); setInterval(() => {}, 2147483647);`,
        );
        const observed = recordSpawns();
        const source = LocalPkgSource.makeChildProcessSource({
          workerCommand: { command: process.execPath, args: [worker, receipt] },
          ioTimeout: Duration.millis(200),
          spawn: observed.spawn,
        });
        const error = yield* Effect.scoped(
          source.open(NodePath.join(directory, "source"), reasons),
        ).pipe(Effect.flip);
        assert.equal(error.reason, "source-timeout");
        assert.equal(observed.children.length, 1);
        const child = observed.children[0]!;
        yield* Effect.promise(() => child.exited);
        const pid = Number(yield* Effect.promise(() => NodeFSP.readFile(receipt, "utf8")));
        assert.equal(pid, child.pid);
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
        assert.equal(LocalPkgSource.killedSourceHelpers(), 0);
      }),
    ),
  );

  it.live("caps new Checks while a killed helper has not reported exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const manifest = manifestFor(Buffer.from("cap fixture"));
        yield* Effect.promise(() =>
          NodeFSP.writeFile(NodePath.join(directory, "oop-update.json"), encodeJson(manifest)),
        );
        const fake = Object.assign(new NodeEvents.EventEmitter(), {
          pid: 123456,
          stdin: new NodeStream.PassThrough(),
          stdout: new NodeStream.PassThrough(),
          stderr: null,
          kill: (_signal: string) => true,
          unref: () => {},
        }) as unknown as NodeChildProcess.ChildProcess;
        let spawnCount = 0;
        const spawn = ((
          command: string,
          args: ReadonlyArray<string>,
          options: NodeChildProcess.SpawnOptions,
        ) => {
          spawnCount += 1;
          return spawnCount === 1 ? fake : NodeChildProcess.spawn(command, [...args], options);
        }) as typeof NodeChildProcess.spawn;
        const source = LocalPkgSource.makeChildProcessSource({
          workerCommand,
          ioTimeout: Duration.millis(500),
          spawn,
        });
        const check = () =>
          LocalPkgUpdates.checkLocalPackage({
            sourceDirectory: directory,
            currentVersion: "0.0.49",
            appArch: "arm64",
            source,
          });
        assert.equal((yield* check().pipe(Effect.flip)).reason, "source-timeout");
        assert.equal(LocalPkgSource.killedSourceHelpers(), 1);
        assert.equal((yield* check().pipe(Effect.flip)).reason, "source-timeout");
        assert.equal(spawnCount, 1);

        // Synthetic no-exit child: a real OS child cannot ignore SIGKILL.
        fake.emit("exit", null, "SIGKILL");
        assert.equal(LocalPkgSource.killedSourceHelpers(), 0);
        assert.isTrue(Option.isSome(yield* check()));
        assert.equal(spawnCount, 2);
      }),
    ),
  );

  it.live("interrupts a real helper mid-copy and removes only the partial stage", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const sourceDirectory = NodePath.join(directory, "published");
        const stagingRoot = NodePath.join(directory, "private-stage");
        yield* Effect.promise(() => NodeFSP.mkdir(sourceDirectory));
        const bytes = Buffer.alloc(2 * 1024 * 1024, 0x61);
        const manifest = manifestFor(bytes);
        const worker = yield* writeWorker(
          directory,
          String.raw`
const frame = (type, payload) => {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([head, payload]));
};
let pending = '';
let reads = 0;
process.stdin.on('data', (chunk) => {
  pending += chunk.toString();
  for (;;) {
    const newline = pending.indexOf('\n');
    if (newline < 0) return;
    const request = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    if (request.op === 'open') frame(1, Buffer.from('{}'));
    if (request.op === 'stat') frame(1, Buffer.from(JSON.stringify({isFile:true,size:2097152})));
    if (request.op === 'read' && ++reads === 1) frame(2, Buffer.alloc(1048576, 0x61));
  }
});
`,
        );
        const observed = recordSpawns();
        const source = LocalPkgSource.makeChildProcessSource({
          workerCommand: { command: process.execPath, args: [worker] },
          ioTimeout: Duration.seconds(2),
          spawn: observed.spawn,
        });
        const progress = yield* Deferred.make<void>();
        const fiber = yield* LocalPkgUpdates.stage({
          sourceDirectory,
          stagingRoot,
          manifest,
          source,
          onProgress: () => Deferred.succeed(progress, undefined).pipe(Effect.asVoid),
        }).pipe(Effect.provide(noWriteSpawner), Effect.forkChild);
        yield* Deferred.await(progress);
        yield* Fiber.interrupt(fiber);
        assert.equal(observed.children.length, 1);
        yield* Effect.promise(() => observed.children[0]!.exited);
        assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(stagingRoot)), []);
        assert.isTrue((yield* Effect.promise(() => NodeFSP.stat(sourceDirectory))).isDirectory());
        assert.equal(LocalPkgSource.killedSourceHelpers(), 0);
      }),
    ),
  );

  it.effect("times out a ready real xattr child and removes the completed copy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* tempDirectory;
        const sourceDirectory = NodePath.join(directory, "published");
        const stagingRoot = NodePath.join(directory, "private-stage");
        const bytes = Buffer.from("quarantine fixture");
        const manifest = manifestFor(bytes);
        const receipt = NodePath.join(directory, "xattr.pid");
        const xattr = NodePath.join(directory, "xattr-fixture");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(sourceDirectory);
          await NodeFSP.writeFile(NodePath.join(sourceDirectory, manifest.pkg), bytes);
          await NodeFSP.writeFile(
            xattr,
            `#!/bin/sh\nprintf '%s' "$$" > "${receipt}"\nprintf 'READY\\n'\nexec /bin/sleep 10000\n`,
          );
          await NodeFSP.chmod(xattr, 0o755);
        });
        const observed = recordSpawns();
        let markReady = () => {};
        const ready = new Promise<void>((resolve) => {
          markReady = resolve;
        });
        const spawn = ((
          command: string,
          args: ReadonlyArray<string>,
          options: NodeChildProcess.SpawnOptions,
        ) => {
          const child = observed.spawn(command, args, options);
          if (command === xattr) child.stdout?.once("data", markReady);
          return child;
        }) as typeof NodeChildProcess.spawn;
        const source = LocalPkgSource.makeChildProcessSource({
          workerCommand,
          xattrCommand: xattr,
          spawn,
        });
        const fiber = yield* LocalPkgUpdates.stage({
          sourceDirectory,
          stagingRoot,
          manifest,
          source,
        }).pipe(Effect.provide(noWriteSpawner), Effect.flip, Effect.forkChild);
        yield* Effect.promise(() => ready);
        yield* TestClock.adjust(Duration.seconds(30));
        const error = yield* Fiber.join(fiber);
        assert.equal(error.reason, "source-timeout");
        assert.deepEqual(yield* Effect.promise(() => NodeFSP.readdir(stagingRoot)), []);
        assert.equal(observed.children.length, 2);
        const child = observed.children[1]!;
        yield* Effect.promise(() => child.exited);
        const pid = Number(yield* Effect.promise(() => NodeFSP.readFile(receipt, "utf8")));
        assert.equal(pid, child.pid);
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
        assert.equal(LocalPkgSource.killedSourceHelpers(), 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.live("releases xattr pipes when exit arrives but close never does", () =>
    Effect.gen(function* () {
      const stdout = new NodeStream.PassThrough();
      const stderr = new NodeStream.PassThrough();
      let unrefs = 0;
      const child = Object.assign(new NodeEvents.EventEmitter(), {
        pid: 123457,
        stdin: null,
        stdout,
        stderr,
        kill: (_signal: string) => true,
        unref: () => {
          unrefs += 1;
        },
      }) as unknown as NodeChildProcess.ChildProcess;
      const spawn = (() => {
        queueMicrotask(() => child.emit("exit", 0, null));
        return child;
      }) as typeof NodeChildProcess.spawn;
      const source = LocalPkgSource.makeChildProcessSource({
        spawn,
        ioTimeout: Duration.millis(50),
      });
      const error = yield* source.readQuarantine("/private/test-source.pkg").pipe(Effect.flip);
      assert.equal(error.reason, "source-timeout");
      assert.isTrue(stdout.destroyed);
      assert.isTrue(stderr.destroyed);
      assert.equal(unrefs, 1);
      assert.equal(LocalPkgSource.killedSourceHelpers(), 0);
    }),
  );

  for (const mode of [
    "oversized",
    "unsolicited",
    "excess-data",
    "garbage",
    "early-exit",
    "invalid-code",
  ] as const) {
    it.live(`rejects a ${mode} worker reply without leaking a source path`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* tempDirectory;
          const path = NodePath.join(directory, "source.json");
          const worker = yield* writeWorker(directory, frameWorker);
          const observed = recordSpawns();
          const source = LocalPkgSource.makeChildProcessSource({
            workerCommand: { command: process.execPath, args: [worker, mode] },
            ioTimeout: Duration.millis(200),
            spawn: observed.spawn,
          });
          const error = yield* Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* source.open(path, reasons);
              if (mode === "excess-data") yield* handle.read(1);
            }),
          ).pipe(Effect.flip);
          assert.equal(error.reason, "folder-unavailable");
          assert.equal(error.code, "helper-failed");
          assert.notInclude(error.message, directory);
          assert.notInclude(error.code ?? "", directory);
          assert.equal(observed.children.length, 1);
          yield* Effect.promise(() => observed.children[0]!.exited);
          assert.equal(LocalPkgSource.killedSourceHelpers(), 0);
        }),
      ),
    );
  }
});
