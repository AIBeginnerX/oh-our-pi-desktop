import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as OwnerMarker from "./ownerMarker.ts";

const sha256 = (bytes: Uint8Array | string): string =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const tempDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-ownermarker-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const owned = (overrides: Partial<OwnerMarker.OwnedMarker> = {}): OwnerMarker.OwnedMarker => ({
  version: 1,
  state: "owned",
  attemptId: "attempt-1",
  threadId: ThreadId.make("thread-1"),
  scriptId: null,
  pgid: null,
  writtenAt: "2026-10-11T00:00:00.000Z",
  ...overrides,
});

const released = (
  overrides: Partial<OwnerMarker.ReleasedMarker> = {},
): OwnerMarker.ReleasedMarker => ({
  version: 1,
  state: "released",
  how: "groups-gone",
  previousSha256: sha256("previous-bytes"),
  previous: null,
  releasedAt: "2026-10-11T00:01:00.000Z",
  ...overrides,
});

// Tags mirror NodeFileSystem's errno mapping: EACCES → PermissionDenied,
// EPERM/EIO → Unknown.
const systemFault = (
  method: string,
  code: string,
  tag: PlatformError.SystemErrorTag = "Unknown",
): PlatformError.PlatformError =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    cause: Object.assign(new Error(`injected ${code}`), { code }),
  });

interface WrappedFsOptions {
  readonly dirPath: string;
  readonly ops?: Array<string>;
  readonly tempSync?: PlatformError.PlatformError;
  readonly dirSync?: PlatformError.PlatformError;
  readonly rename?: PlatformError.PlatformError;
  readonly readFile?: (call: number) => PlatformError.PlatformError | undefined;
  // Gates park the op after signalling, until the test interrupts the fiber.
  readonly tempSyncGate?: Deferred.Deferred<void>;
  readonly renameGate?: Deferred.Deferred<void>;
  // Dies inside temp writeAll — a defect exit, not a typed failure.
  readonly tempWriteDefect?: unknown;
  // Runs with the real FileSystem before the wx open — e.g. plants a foreign
  // file at the candidate path so the real open reports EEXIST.
  readonly beforeTempOpen?: (tempPath: string) => Effect.Effect<void, PlatformError.PlatformError>;
  // After the real wx open succeeds, the open's masked return is gated:
  // `created` receipts the live descriptor, `release` opens the return so a
  // pending interrupt is delivered exactly at the acquisition boundary.
  readonly tempOpenReturnGate?: {
    readonly created: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  };
}

// Records and injects into the exact ops transitionMarker performs. The
// "close" marker is registered before the real descriptor-close finalizer so
// it records after the fd is actually closed (finalizers run LIFO).
const wrappedFs = Effect.fnUntraced(function* (
  opts: WrappedFsOptions,
): Effect.fn.Return<FileSystem.FileSystem, never, FileSystem.FileSystem> {
  const real = yield* FileSystem.FileSystem;
  let readCalls = 0;
  const wrapFile = (tag: "temp" | "dir", file: FileSystem.File): FileSystem.File => ({
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: file.stat,
    seek: (offset, from) => file.seek(offset, from),
    sync: Effect.suspend(() => {
      opts.ops?.push(`sync:${tag}`);
      if (tag === "temp" && opts.tempSyncGate !== undefined) {
        return Effect.andThen(Deferred.succeed(opts.tempSyncGate, undefined), Effect.never);
      }
      const fault = tag === "temp" ? opts.tempSync : opts.dirSync;
      return fault === undefined ? file.sync : Effect.fail(fault);
    }),
    read: (buffer) => file.read(buffer),
    readAlloc: (size) => file.readAlloc(size),
    truncate: (length) => file.truncate(length),
    write: (buffer) => file.write(buffer),
    writeAll: (buffer) => {
      opts.ops?.push(`writeAll:${tag}`);
      return tag === "temp" && opts.tempWriteDefect !== undefined
        ? Effect.die(opts.tempWriteDefect)
        : file.writeAll(buffer);
    },
  });
  return FileSystem.FileSystem.of({
    ...real,
    open: (candidate, options) =>
      Effect.gen(function* () {
        const tag = candidate === opts.dirPath ? "dir" : "temp";
        opts.ops?.push(
          `open:${tag}:${options?.flag ?? "r"}:${options?.mode === undefined ? "-" : options.mode.toString(8)}`,
        );
        if (tag === "temp" && opts.beforeTempOpen !== undefined) {
          yield* opts.beforeTempOpen(candidate);
        }
        const acquire = Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => opts.ops?.push(`close:${tag}`)));
          return wrapFile(tag, yield* real.open(candidate, options));
        });
        const gate = tag === "temp" ? opts.tempOpenReturnGate : undefined;
        if (gate === undefined) return yield* acquire;
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const file = yield* acquire;
            yield* Deferred.succeed(gate.created, undefined);
            yield* Deferred.await(gate.release);
            return file;
          }),
        );
      }),
    rename: (from, to) => {
      opts.ops?.push("rename");
      if (opts.renameGate !== undefined) {
        return Effect.andThen(Deferred.succeed(opts.renameGate, undefined), Effect.never);
      }
      return opts.rename === undefined ? real.rename(from, to) : Effect.fail(opts.rename);
    },
    readFile: (candidate) => {
      opts.ops?.push("readFile");
      const fault = opts.readFile?.(++readCalls);
      return fault === undefined ? real.readFile(candidate) : Effect.fail(fault);
    },
  });
});

it.layer(NodeServices.layer, { excludeTestServices: true })("ownerMarker", (it) => {
  describe("readMarker", () => {
    it.effect("reports absent for a missing marker", () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        expect(
          yield* OwnerMarker.readMarker(path.join(dir, OwnerMarker.OWNER_MARKER_FILE)),
        ).toEqual({ kind: "absent" });
      }).pipe(Effect.scoped),
    );

    it.effect("round-trips owned and released markers with the sha256 of their bytes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);

        for (const marker of [owned(), released()]) {
          const bytes = JSON.stringify(marker);
          yield* fs.writeFileString(markerPath, bytes);
          const read = yield* OwnerMarker.readMarker(markerPath);
          expect(read).toEqual({ kind: marker.state, sha256: sha256(bytes), marker });
        }
      }).pipe(Effect.scoped),
    );

    it.effect("classifies empty, non-JSON, schema-mismatch, and oversized content as corrupt", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);

        for (const bytes of [
          "",
          "{not json",
          JSON.stringify({ version: 2, state: "unknown" }),
          "x".repeat(OwnerMarker.OWNER_MARKER_MAX_BYTES + 1),
        ]) {
          yield* fs.writeFileString(markerPath, bytes);
          const read = yield* OwnerMarker.readMarker(markerPath);
          expect(read).toEqual({
            kind: "corrupt",
            sha256: sha256(bytes),
            bytes: bytes.length,
          });
        }
      }).pipe(Effect.scoped),
    );

    it.effect("reports unreadable when the marker path is a directory", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        yield* fs.makeDirectory(markerPath);
        expect(yield* OwnerMarker.readMarker(markerPath)).toEqual({ kind: "unreadable" });
      }).pipe(Effect.scoped),
    );
  });

  describe("transitionMarker", () => {
    it.effect(
      "applies free → owned and exact → released with the sha256 of the written bytes",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* tempDir;
          const path = yield* Path.Path;
          const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);

          const marker = owned({ pgid: 42 });
          const applied = yield* OwnerMarker.transitionMarker(markerPath, { kind: "free" }, marker);
          expect(applied.kind).toBe("applied");
          if (applied.kind !== "applied") return;
          expect(applied.sha256).toBe(sha256(yield* fs.readFile(markerPath)));
          expect(yield* OwnerMarker.readMarker(markerPath)).toEqual({
            kind: "owned",
            sha256: applied.sha256,
            marker,
          });

          const next = released({
            previousSha256: applied.sha256,
            previous: {
              attemptId: marker.attemptId,
              threadId: marker.threadId,
              scriptId: marker.scriptId,
              pgid: marker.pgid,
            },
          });
          const releasedTransition = yield* OwnerMarker.transitionMarker(
            markerPath,
            { kind: "exact", sha256: applied.sha256 },
            next,
          );
          expect(releasedTransition.kind).toBe("applied");
          if (releasedTransition.kind !== "applied") return;
          expect(releasedTransition.sha256).toBe(sha256(yield* fs.readFile(markerPath)));
          expect(yield* OwnerMarker.readMarker(markerPath)).toEqual({
            kind: "released",
            sha256: releasedTransition.sha256,
            marker: next,
          });

          // A released marker is free again.
          const reacquired = yield* OwnerMarker.transitionMarker(
            markerPath,
            { kind: "free" },
            owned({ attemptId: "attempt-2" }),
          );
          expect(reacquired.kind).toBe("applied");
        }).pipe(Effect.scoped),
    );

    it.effect("accepts an exact expectation matching corrupt bytes", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        yield* fs.writeFileString(markerPath, "{corrupt");
        const transition = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "exact", sha256: sha256("{corrupt") },
          owned(),
        );
        expect(transition.kind).toBe("applied");
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a mismatched expectation without touching the bytes on disk", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);

        const onAbsent = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "exact", sha256: sha256("anything") },
          owned(),
        );
        expect(onAbsent).toEqual({ kind: "rejected", observed: { kind: "absent" } });

        const marker = owned();
        const applied = yield* OwnerMarker.transitionMarker(markerPath, { kind: "free" }, marker);
        expect(applied.kind).toBe("applied");
        if (applied.kind !== "applied") return;
        const before = yield* fs.readFile(markerPath);

        for (const expectation of [
          { kind: "free" },
          { kind: "exact", sha256: sha256("stale-bytes") },
        ] as const) {
          const rejected = yield* OwnerMarker.transitionMarker(markerPath, expectation, released());
          expect(rejected).toEqual({
            kind: "rejected",
            observed: { kind: "owned", sha256: applied.sha256, marker },
          });
          expect(yield* fs.readFile(markerPath)).toEqual(before);
        }

        // An unreadable marker also satisfies nothing and nothing is written.
        yield* fs.remove(markerPath);
        yield* fs.makeDirectory(markerPath);
        const onUnreadable = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "free" },
          owned(),
        );
        expect(onUnreadable).toEqual({
          kind: "rejected",
          observed: { kind: "unreadable" },
        });
      }).pipe(Effect.scoped),
    );

    it.effect("orders the replace open(wx) → write → sync → close → rename → dir sync", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        const ops: Array<string> = [];
        const wrapped = yield* wrappedFs({ dirPath: dir, ops });
        const transition = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "free" },
          owned(),
        ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
        expect(transition.kind).toBe("applied");
        expect(ops).toEqual([
          "readFile",
          "open:temp:wx:600",
          "writeAll:temp",
          "sync:temp",
          "close:temp",
          "rename",
          "open:dir:r:-",
          "sync:dir",
          "close:dir",
          "readFile",
        ]);
        expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "reports uncertain with the old bytes still on disk when a pre-rename step fails",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* tempDir;
          const path = yield* Path.Path;
          const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
          yield* fs.writeFileString(markerPath, JSON.stringify(owned()));
          const before = yield* fs.readFile(markerPath);
          const beforeSha256 = sha256(before);

          for (const faults of [
            { tempSync: systemFault("sync", "EIO") },
            { rename: systemFault("rename", "EIO") },
          ]) {
            const wrapped = yield* wrappedFs({ dirPath: dir, ...faults });
            const transition = yield* OwnerMarker.transitionMarker(
              markerPath,
              { kind: "exact", sha256: beforeSha256 },
              released(),
            ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
            // The replace never reached rename, so the observed bytes are the
            // old owned marker — verified against the disk, not assumed.
            expect(transition).toEqual({
              kind: "uncertain",
              observed: expect.objectContaining({ kind: "owned", sha256: beforeSha256 }),
            });
            expect(yield* fs.readFile(markerPath)).toEqual(before);
            expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
          }
        }).pipe(Effect.scoped),
    );

    it.effect(
      "reports uncertain with the new bytes already on disk when the directory sync fails",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* tempDir;
          const path = yield* Path.Path;
          const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
          yield* fs.writeFileString(markerPath, JSON.stringify(owned()));
          const beforeSha256 = sha256(yield* fs.readFile(markerPath));

          const wrapped = yield* wrappedFs({
            dirPath: dir,
            dirSync: systemFault("sync", "EIO"),
          });
          const transition = yield* OwnerMarker.transitionMarker(
            markerPath,
            { kind: "exact", sha256: beforeSha256 },
            released(),
          ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
          // The rename already happened: the uncertain observation is the NEW
          // released marker, never a claim that old bytes remain.
          expect(transition).toEqual({
            kind: "uncertain",
            observed: expect.objectContaining({ kind: "released" }),
          });
          const after = yield* fs.readFile(markerPath);
          expect(sha256(after)).toBe(
            transition.kind === "uncertain" && transition.observed.kind === "released"
              ? transition.observed.sha256
              : "unreachable",
          );
          expect(sha256(after)).not.toBe(beforeSha256);
          expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
        }).pipe(Effect.scoped),
    );

    it.effect("applies when the directory sync reports EPERM", () =>
      Effect.gen(function* () {
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        const wrapped = yield* wrappedFs({
          dirPath: dir,
          dirSync: systemFault("sync", "EPERM"),
        });
        const transition = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "free" },
          owned(),
        ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
        expect(transition.kind).toBe("applied");
      }).pipe(Effect.scoped),
    );

    it.effect("reports uncertain with an unreadable observation when the re-read fails", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        const marker = owned();
        yield* fs.writeFileString(markerPath, JSON.stringify(marker));
        const beforeSha256 = sha256(yield* fs.readFile(markerPath));

        // Call 1 is the expectation read; call 2 is the post-replace re-read.
        const wrapped = yield* wrappedFs({
          dirPath: dir,
          readFile: (call) =>
            call === 2 ? systemFault("readFile", "EACCES", "PermissionDenied") : undefined,
        });
        const transition = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "exact", sha256: beforeSha256 },
          released(),
        ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
        expect(transition).toEqual({
          kind: "uncertain",
          observed: { kind: "unreadable" },
        });
        // The replace actually completed — the disk holds the new bytes.
        expect(yield* OwnerMarker.readMarker(markerPath)).toEqual(
          expect.objectContaining({ kind: "released" }),
        );
      }).pipe(Effect.scoped),
    );

    it.effect("removes its owned temp when interrupted inside the temp sync", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        yield* fs.writeFileString(markerPath, JSON.stringify(owned()));
        const before = yield* fs.readFile(markerPath);

        const entered = yield* Deferred.make<void>();
        const wrapped = yield* wrappedFs({ dirPath: dir, tempSyncGate: entered });
        const fiber = yield* Effect.forkChild(
          OwnerMarker.transitionMarker(
            markerPath,
            { kind: "exact", sha256: sha256(before) },
            released(),
          ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped)),
        );
        // The fiber is parked inside temp sync — the temp file exists on
        // disk with all bytes written. Interrupting must still unlink it.
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
        expect(yield* fs.readFile(markerPath)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    it.effect("removes its owned temp when interrupted at the rename boundary", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        yield* fs.writeFileString(markerPath, JSON.stringify(owned()));
        const before = yield* fs.readFile(markerPath);

        const entered = yield* Deferred.make<void>();
        const wrapped = yield* wrappedFs({ dirPath: dir, renameGate: entered });
        const fiber = yield* Effect.forkChild(
          OwnerMarker.transitionMarker(
            markerPath,
            { kind: "exact", sha256: sha256(before) },
            released(),
          ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped)),
        );
        // Parked at rename: the temp is fully written and synced, and its
        // descriptor is already closed. Interrupting must still unlink it.
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
        expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
        expect(yield* fs.readFile(markerPath)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    it.effect("removes its owned temp when the replace exits with a defect", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        yield* fs.writeFileString(markerPath, JSON.stringify(owned()));
        const before = yield* fs.readFile(markerPath);

        const wrapped = yield* wrappedFs({
          dirPath: dir,
          tempWriteDefect: new Error("injected defect"),
        });
        const exit = yield* Effect.exit(
          OwnerMarker.transitionMarker(
            markerPath,
            { kind: "exact", sha256: sha256(before) },
            released(),
          ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped)),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true);
        }
        expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
        expect(yield* fs.readFile(markerPath)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    it.effect("records ownership before a pending interrupt at the open return", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        yield* fs.writeFileString(markerPath, JSON.stringify(owned()));
        const before = yield* fs.readFile(markerPath);

        const created = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const wrapped = yield* wrappedFs({
          dirPath: dir,
          tempOpenReturnGate: { created, release },
        });
        const fiber = yield* Effect.forkChild(
          OwnerMarker.transitionMarker(
            markerPath,
            { kind: "exact", sha256: sha256(before) },
            released(),
          ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped)),
        );
        // The real wx open already created the temp and holds a live
        // descriptor behind the gate. The interrupt request is registered
        // synchronously — before the return gate opens — so it is pending
        // exactly at the acquisition-return boundary.
        yield* Deferred.await(created);
        yield* Effect.sync(() => fiber.interruptUnsafe());
        yield* Deferred.succeed(release, undefined);
        const exit = yield* Effect.exit(Fiber.join(fiber));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(exit.cause.reasons.some(Cause.isInterruptReason)).toBe(true);
        }
        // ownedTemp was recorded inside the uninterruptible handoff, so the
        // owned temp is unlinked while the target bytes stay untouched.
        expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);
        expect(yield* fs.readFile(markerPath)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    it.effect("never unlinks a candidate temp path it failed to create", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        yield* fs.writeFileString(markerPath, JSON.stringify(owned()));
        const before = yield* fs.readFile(markerPath);

        // A foreign file lands at this invocation's candidate name just
        // before the real wx open runs, so the open reports EEXIST.
        const sentinel = "foreign-bytes-not-ours";
        let candidate: string | undefined;
        const wrapped = yield* wrappedFs({
          dirPath: dir,
          beforeTempOpen: (tempPath) => {
            candidate = tempPath;
            return fs.writeFileString(tempPath, sentinel);
          },
        });
        const transition = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "exact", sha256: sha256(before) },
          released(),
        ).pipe(Effect.provideService(FileSystem.FileSystem, wrapped));
        expect(transition).toEqual({
          kind: "uncertain",
          observed: expect.objectContaining({ kind: "owned", sha256: sha256(before) }),
        });
        // The pre-existing bytes survive byte-for-byte — this invocation
        // never created that file, so it had no authority to unlink it.
        expect(candidate).toBeDefined();
        if (candidate === undefined) return;
        expect(yield* fs.readFileString(candidate)).toBe(sentinel);
        expect(yield* fs.readFile(markerPath)).toEqual(before);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects an oversized next without writing, on absent and owned targets", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* tempDir;
        const path = yield* Path.Path;
        const markerPath = path.join(dir, OwnerMarker.OWNER_MARKER_FILE);
        const encoded = (marker: OwnerMarker.OwnerMarker) =>
          new TextEncoder().encode(JSON.stringify(marker));

        // Exactly at the cap, a valid marker still applies and reads back.
        const padBase = encoded(owned({ attemptId: "" })).length;
        const atCap = owned({
          attemptId: "a".repeat(OwnerMarker.OWNER_MARKER_MAX_BYTES - padBase),
        });
        expect(encoded(atCap).length).toBe(OwnerMarker.OWNER_MARKER_MAX_BYTES);
        const applied = yield* OwnerMarker.transitionMarker(markerPath, { kind: "free" }, atCap);
        expect(applied.kind).toBe("applied");
        expect(yield* OwnerMarker.readMarker(markerPath)).toEqual(
          expect.objectContaining({
            kind: "owned",
            marker: expect.objectContaining({ attemptId: atCap.attemptId }),
          }),
        );

        // One byte over the cap, encoded bytes are corrupt to readMarker —
        // refuse before any write.
        const over = owned({ attemptId: "a".repeat(OwnerMarker.OWNER_MARKER_MAX_BYTES) });
        expect(encoded(over).length).toBeGreaterThan(OwnerMarker.OWNER_MARKER_MAX_BYTES);
        const before = yield* fs.readFile(markerPath);
        const onOwned = yield* OwnerMarker.transitionMarker(
          markerPath,
          { kind: "exact", sha256: sha256(before) },
          over,
        );
        expect(onOwned).toEqual({
          kind: "rejected",
          observed: expect.objectContaining({ kind: "owned", sha256: sha256(before) }),
        });
        expect(yield* fs.readFile(markerPath)).toEqual(before);
        expect((yield* fs.readDirectory(dir)).sort()).toEqual([OwnerMarker.OWNER_MARKER_FILE]);

        yield* fs.remove(markerPath);
        const onAbsent = yield* OwnerMarker.transitionMarker(markerPath, { kind: "free" }, over);
        expect(onAbsent).toEqual({ kind: "rejected", observed: { kind: "absent" } });
        expect(yield* fs.readDirectory(dir)).toEqual([]);

        // Those same encoded bytes on disk read back corrupt with the
        // digest of the raw bytes.
        yield* fs.writeFile(markerPath, encoded(over));
        expect(yield* OwnerMarker.readMarker(markerPath)).toEqual({
          kind: "corrupt",
          sha256: sha256(encoded(over)),
          bytes: encoded(over).length,
        });
      }).pipe(Effect.scoped),
    );
  });
});
