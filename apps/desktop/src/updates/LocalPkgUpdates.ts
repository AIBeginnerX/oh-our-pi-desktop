// @effect-diagnostics nodeBuiltinImport:off -- O_NOFOLLOW opens, bounded chunk copies and hashing of local files need node:fs handles that the Effect FileSystem does not expose, and the Windows setup must outlive the app, which a scoped Effect child process does not.
import type { DesktopRuntimeArch } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { LocalPkgUpdateError, errnoCode, failure, type Reason } from "./LocalPkgUpdateError.ts";
import {
  QUARANTINE_ATTRIBUTE,
  SOURCE_IO_TIMEOUT,
  defaultLocalPkgSource,
  type LocalPkgSource,
} from "./LocalPkgSource.ts";

export { LocalPkgUpdateError };

/**
 * Local-folder updates for the OoP macOS and Windows builds: a manifest next to
 * an update `.pkg` (macOS) or setup `.exe` (Windows) in a (possibly
 * network-mounted) folder is checked, the package is copied into a private
 * staging folder, and the macOS Installer or the Windows setup is opened on the
 * staged copy. Everything read from the update folder goes through a
 * `LocalPkgSource` (a killable helper process in production), so a stalled
 * mount can never hang the app. Local files use `LocalPkgFs` and writes use
 * `ChildProcessSpawner`, so DesktopUpdates stays a thin integration and tests
 * can break either boundary.
 *
 * Trust model: the manifest hash only proves the staged bytes equal what the
 * folder published; anyone who can write the folder can replace both files.
 * Error messages are shown in the renderer and mirrored to remote clients, so
 * they never contain a path; only `code` (an errno or exit status) is kept.
 */

export const CONFIG_FILE_NAME = "oop-local-update.json";
/** A per-device update folder in the app's user data, checked before the bundled candidates. */
export const FOLDER_OVERRIDE_FILE_NAME = "oop-update-folder.json";
export const MANIFEST_FILE_NAME = "oop-update.json";
export const INSTALLER_BUNDLE_ID = "com.apple.installer";

const MAX_CONFIG_BYTES = 4096;
const MAX_MANIFEST_BYTES = 4096;
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const COPY_CHUNK_BYTES = 1024 * 1024;
const STAGING_DIRECTORY_NAME = "oop-local-update";
const STAGE_DIRECTORY_PREFIX = "stage-";
const INSTALLER_OPEN_TIMEOUT = Duration.seconds(10);
const OPEN_COMMAND = "/usr/bin/open";
const XATTR_COMMAND = "/usr/bin/xattr";
const QUARANTINE_VALUE = /^[\x20-\x7e]{1,512}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const NOFOLLOW_READ =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;
const EXCLUSIVE_WRITE =
  NodeFS.constants.O_WRONLY |
  NodeFS.constants.O_CREAT |
  NodeFS.constants.O_EXCL |
  NodeFS.constants.O_NOFOLLOW;

/** The slice of node:fs/promises used for local files; tests wrap it to inject faults. */
export type LocalPkgFs = Pick<
  typeof NodeFSP,
  "open" | "lstat" | "mkdir" | "mkdtemp" | "rm" | "chmod"
>;
export const nodeLocalPkgFs: LocalPkgFs = NodeFSP;

const fsStep = <A>(reason: Reason, thunk: () => Promise<A>) =>
  Effect.tryPromise({ try: thunk, catch: (cause) => failure(reason, cause) });

/** Local files only (config, staged target, staged verification); the update folder uses a `LocalPkgSource`. */
const openFile = (
  fs: LocalPkgFs,
  path: string,
  flags: number,
  reasons: { readonly unsafe: Reason; readonly unreadable: Reason },
  mode?: number,
) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: () => fs.open(path, flags, mode),
      catch: (cause) => {
        const code = errnoCode(cause);
        const symlink = code === "ELOOP" || code === "EMLINK";
        return failure(symlink ? reasons.unsafe : reasons.unreadable, cause);
      },
    }),
    (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
  );

// Windows has no POSIX owner or permission bits; its stat reports 0o666 for every file.
const hasPosixPermissions = typeof process.getuid === "function";

const isOwnedByCurrentUser = (stat: { readonly uid: number }) => {
  const uid = process.getuid?.();
  return uid === undefined || stat.uid === uid;
};

/** Reads the bundled config: an ordinary local file, at most `maxBytes`, never through a symlink. */
const readLocalSmallFile = (
  fs: LocalPkgFs,
  path: string,
  maxBytes: number,
  reasons: { readonly invalid: Reason; readonly unreadable: Reason },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* openFile(fs, path, NOFOLLOW_READ, {
        unsafe: reasons.invalid,
        unreadable: reasons.unreadable,
      });
      const stat = yield* fsStep(reasons.unreadable, () => handle.stat());
      if (!stat.isFile() || stat.size > maxBytes) {
        return yield* new LocalPkgUpdateError({ reason: reasons.invalid });
      }
      const buffer = Buffer.alloc(maxBytes + 1);
      const length = yield* fsStep(reasons.unreadable, async () => {
        let filled = 0;
        while (filled < buffer.length) {
          const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, null);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return filled;
      });
      if (length > maxBytes) return yield* new LocalPkgUpdateError({ reason: reasons.invalid });
      return yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)),
        catch: () => new LocalPkgUpdateError({ reason: reasons.invalid }),
      });
    }),
  );

/** Reads a small file from the update folder: at most `maxBytes`, a regular file only, never through a symlink. */
const readSourceSmallFile = (
  source: LocalPkgSource,
  path: string,
  maxBytes: number,
  reasons: { readonly invalid: Reason; readonly unreadable: Reason },
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* source.open(path, {
        unsafe: reasons.invalid,
        unreadable: reasons.unreadable,
      });
      const stat = yield* handle.stat;
      if (!stat.isFile || stat.size > maxBytes) {
        return yield* new LocalPkgUpdateError({ reason: reasons.invalid });
      }
      // One byte past the limit, so an oversized file is noticed.
      const chunks: Array<Uint8Array> = [];
      let filled = 0;
      while (filled <= maxBytes) {
        const chunk = yield* handle.read(maxBytes + 1 - filled);
        if (chunk.length === 0) break;
        chunks.push(chunk);
        filled += chunk.length;
      }
      if (filled > maxBytes) return yield* new LocalPkgUpdateError({ reason: reasons.invalid });
      return yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
        catch: () => new LocalPkgUpdateError({ reason: reasons.invalid }),
      });
    }),
  );

// ---------------------------------------------------------------------------
// Configuration bundled with the app (oop-local-update.json)
// ---------------------------------------------------------------------------

const ConfigFile = Schema.Struct({
  /** The single update folder of older builds. */
  directory: Schema.optionalKey(Schema.String),
  /** Update folders in order of preference; `~` is the home folder and `*` matches within one segment. */
  directories: Schema.optionalKey(Schema.Array(Schema.String)),
  folderKind: Schema.optionalKey(Schema.Literal("google-drive")),
  connectUrl: Schema.optionalKey(Schema.String),
});
const FolderOverrideFile = Schema.Struct({ directory: Schema.String });
const decodeFolderOverrideJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(FolderOverrideFile),
  { onExcessProperty: "error" },
);
const decodeConfigJson = Schema.decodeUnknownEffect(Schema.fromJsonString(ConfigFile), {
  onExcessProperty: "error",
});

export type LocalPkgConfig =
  | { readonly _tag: "Absent" }
  | {
      readonly _tag: "Ready";
      /** Folder patterns in order of preference; see `expandUpdateDirectories`. */
      readonly directories: ReadonlyArray<string>;
      readonly folderKind?: "google-drive";
      readonly connectUrl?: string;
    }
  | { readonly _tag: "Invalid"; readonly error: LocalPkgUpdateError };

const isSafeDirectory = (directory: string) =>
  NodePath.isAbsolute(directory) &&
  directory.length <= 1024 &&
  !directory.includes("\0") &&
  !directory.split(/[\\/]/).includes("..") &&
  !directory.includes("*");

/** A folder pattern: absolute once `~` is the home folder, with at most one `*` per segment. */
const isSafeDirectoryPattern = (pattern: string) => {
  const rooted = /^~(?=$|[\\/])/.test(pattern) ? `/home${pattern.slice(1)}` : pattern;
  return (
    NodePath.isAbsolute(rooted) &&
    pattern.length <= 1024 &&
    !pattern.includes("\0") &&
    rooted.split(/[\\/]/).every((segment) => segment !== ".." && segment.split("*").length <= 2)
  );
};

/** The `smb://host/share` holding the update folder, so a new PC can be pointed at it. */
const isSafeConnectUrl = (connectUrl: string) => {
  if (connectUrl.length > 512) return false;
  try {
    const url = new URL(connectUrl);
    return (
      url.protocol === "smb:" &&
      url.hostname.length > 0 &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

/**
 * Reads the bundled config. A missing file means this build has no local
 * updates; a file that exists but cannot be trusted is `Invalid` so the caller
 * disables updates instead of falling back to another feed.
 */
export const loadConfig = (
  resourcesPath: string,
  fs: LocalPkgFs = nodeLocalPkgFs,
): Effect.Effect<LocalPkgConfig> =>
  readLocalSmallFile(fs, NodePath.join(resourcesPath, CONFIG_FILE_NAME), MAX_CONFIG_BYTES, {
    invalid: "config-invalid",
    unreadable: "config-invalid",
  }).pipe(
    Effect.flatMap((text) =>
      decodeConfigJson(text).pipe(
        Effect.mapError(() => new LocalPkgUpdateError({ reason: "config-invalid" })),
      ),
    ),
    Effect.flatMap(({ directory, directories, folderKind, connectUrl }) => {
      const patterns = [...(directories ?? []), ...(directory === undefined ? [] : [directory])];
      return patterns.length > 0 &&
        patterns.every(isSafeDirectoryPattern) &&
        (connectUrl === undefined || isSafeConnectUrl(connectUrl))
        ? Effect.succeed<LocalPkgConfig>({
            _tag: "Ready",
            directories: patterns,
            ...(folderKind === undefined ? {} : { folderKind }),
            ...(connectUrl === undefined ? {} : { connectUrl }),
          })
        : Effect.fail(new LocalPkgUpdateError({ reason: "config-invalid" }));
    }),
    Effect.catchTag("LocalPkgUpdateError", (error) =>
      Effect.succeed<LocalPkgConfig>(
        error.code === "ENOENT" ? { _tag: "Absent" } : { _tag: "Invalid", error },
      ),
    ),
  );

/**
 * The update folder this device names in its user data, if any: `{ "directory": "<absolute path>" }`.
 * A missing or invalid file is ignored, so the bundled candidates still apply.
 */
export const readFolderOverride = (userDataDirectory: string, fs: LocalPkgFs = nodeLocalPkgFs) =>
  readLocalSmallFile(
    fs,
    NodePath.join(userDataDirectory, FOLDER_OVERRIDE_FILE_NAME),
    MAX_CONFIG_BYTES,
    {
      invalid: "config-invalid",
      unreadable: "config-invalid",
    },
  ).pipe(
    Effect.flatMap((text) => decodeFolderOverrideJson(text)),
    Effect.map(({ directory }) =>
      isSafeDirectory(directory) ? NodePath.normalize(directory) : undefined,
    ),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Concrete folders for the configured patterns, in order: `~` becomes the home folder and a
 * segment with `*` matches the entries of its parent (Google Drive names its root after the
 * account). Only pattern parents are listed, which are local folders such as
 * `~/Library/CloudStorage`; a pattern without `*` is never touched here.
 */
export const expandUpdateDirectories = (
  patterns: ReadonlyArray<string>,
  input: {
    readonly home: string;
    readonly listDirectory?: (path: string) => Promise<ReadonlyArray<string>>;
  },
) =>
  Effect.gen(function* () {
    const list = input.listDirectory ?? ((path: string) => NodeFSP.readdir(path));
    const expanded: Array<string> = [];
    for (const pattern of patterns) {
      const rooted = /^~(?=$|[\\/])/.test(pattern) ? `${input.home}${pattern.slice(1)}` : pattern;
      if (!rooted.includes("*")) {
        expanded.push(NodePath.normalize(rooted));
        continue;
      }
      const segments = NodePath.normalize(rooted).split(NodePath.sep);
      let prefixes = [segments[0] === "" ? NodePath.sep : `${segments[0]}${NodePath.sep}`];
      for (const segment of segments.slice(1)) {
        if (segment === "") continue;
        if (!segment.includes("*")) {
          prefixes = prefixes.map((prefix) => NodePath.join(prefix, segment));
          continue;
        }
        const [head = "", tail = ""] = segment.split("*");
        const next: Array<string> = [];
        for (const prefix of prefixes) {
          const names = yield* Effect.promise(() =>
            list(prefix).then(
              (entries) => [...entries].toSorted(),
              () => [] as Array<string>,
            ),
          );
          for (const name of names) {
            if (
              name.length >= head.length + tail.length &&
              name.startsWith(head) &&
              name.endsWith(tail)
            ) {
              next.push(NodePath.join(prefix, name));
            }
          }
        }
        prefixes = next;
      }
      expanded.push(...prefixes);
    }
    return [...new Set(expanded)];
  });

/** Private staging folder inside the app's own user data directory. */
export const stagingRootFor = (userDataDirectory: string) =>
  NodePath.join(userDataDirectory, STAGING_DIRECTORY_NAME);

// ---------------------------------------------------------------------------
// Manifest (oop-update.json) and version policy
// ---------------------------------------------------------------------------

const Manifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  platform: Schema.Literals(["darwin", "win32"]),
  arch: Schema.Literals(["arm64", "x64"]),
  version: Schema.String.check(Schema.isPattern(STABLE_VERSION)),
  pkg: Schema.String,
  size: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_PACKAGE_BYTES })),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
});
export type LocalPkgManifest = typeof Manifest.Type;
const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest), {
  onExcessProperty: "error",
});

/** Canonical stable `major.minor.patch`: no leading zeros, safe integers. */
export const parseStableVersion = (
  version: string,
): Option.Option<readonly [number, number, number]> => {
  const match = STABLE_VERSION.exec(version);
  if (match === null) return Option.none();
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  return parts.every((part) => Number.isSafeInteger(part)) ? Option.some(parts) : Option.none();
};

export const isNewerVersion = (
  candidate: readonly [number, number, number],
  current: readonly [number, number, number],
) => {
  for (const index of [0, 1, 2] as const) {
    if (candidate[index] !== current[index]) return candidate[index] > current[index];
  }
  return false;
};

/**
 * Reads and validates the folder manifest. `None` means the folder offers
 * nothing newer than the running app (equal or older is never offered).
 */
export const checkLocalPackage = Effect.fn("desktop.updates.localPkg.check")(function* (input: {
  readonly sourceDirectory: string;
  readonly currentVersion: string;
  readonly appArch: DesktopRuntimeArch;
  /** The running app's platform; a manifest for the other platform is never offered. */
  readonly platform?: "darwin" | "win32";
  readonly source?: LocalPkgSource;
}) {
  const source = input.source ?? defaultLocalPkgSource;
  const manifestPath = NodePath.join(input.sourceDirectory, MANIFEST_FILE_NAME);
  // The whole manifest read is bounded, not only each request: a folder that dribbles one
  // byte every few seconds must not stretch a check. Interruption closes the helper within
  // its own bound. (Staging a package has no total bound, only the per-request one.)
  const text = yield* readSourceSmallFile(source, manifestPath, MAX_MANIFEST_BYTES, {
    invalid: "manifest-invalid",
    unreadable: "folder-unavailable",
  }).pipe(
    Effect.timeoutOption(SOURCE_IO_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new LocalPkgUpdateError({ reason: "source-timeout" })),
        onSome: Effect.succeed,
      }),
    ),
  );
  const manifest = yield* decodeManifestJson(text).pipe(
    Effect.mapError(() => new LocalPkgUpdateError({ reason: "manifest-invalid" })),
  );
  const candidate = parseStableVersion(manifest.version);
  if (
    Option.isNone(candidate) ||
    manifest.pkg !==
      (manifest.platform === "win32"
        ? `OoP-${manifest.version}-${manifest.arch}.exe`
        : `OoP-${manifest.version}-${manifest.arch}-update.pkg`)
  ) {
    return yield* new LocalPkgUpdateError({ reason: "manifest-invalid" });
  }
  if (input.appArch !== manifest.arch || manifest.platform !== (input.platform ?? "darwin")) {
    return yield* new LocalPkgUpdateError({ reason: "manifest-unsupported" });
  }
  const current = parseStableVersion(input.currentVersion);
  if (Option.isNone(current)) {
    return yield* new LocalPkgUpdateError({ reason: "version-unknown" });
  }
  return isNewerVersion(candidate.value, current.value) ? Option.some(manifest) : Option.none();
});

/** Reasons that mean "this folder is not here right now", so the next candidate is tried. */
const UNREACHABLE_REASONS: ReadonlySet<Reason> = new Set(["folder-unavailable", "source-timeout"]);

/**
 * Checks the first candidate folder that answers. A folder that is missing or does not answer
 * in time is skipped; any other failure (a bad manifest, a package for another machine) stops
 * the check, because that folder is the one that answered. With no folder reachable, a Google
 * Drive config says how to set Drive up.
 */
export const checkLocalPackageIn = Effect.fn("desktop.updates.localPkg.checkIn")(function* (input: {
  readonly sourceDirectories: ReadonlyArray<string>;
  readonly folderKind?: "google-drive";
  readonly currentVersion: string;
  readonly appArch: DesktopRuntimeArch;
  readonly platform?: "darwin" | "win32";
  readonly source?: LocalPkgSource;
}) {
  let last: LocalPkgUpdateError | undefined;
  for (const sourceDirectory of input.sourceDirectories) {
    const result = yield* Effect.result(
      checkLocalPackage({
        sourceDirectory,
        currentVersion: input.currentVersion,
        appArch: input.appArch,
        ...(input.platform === undefined ? {} : { platform: input.platform }),
        ...(input.source === undefined ? {} : { source: input.source }),
      }),
    );
    if (Result.isSuccess(result)) return { sourceDirectory, offered: result.success };
    if (!UNREACHABLE_REASONS.has(result.failure.reason)) return yield* result.failure;
    last = result.failure;
  }
  return yield* input.folderKind === "google-drive"
    ? new LocalPkgUpdateError({ reason: "drive-folder-unavailable" })
    : (last ?? new LocalPkgUpdateError({ reason: "folder-unavailable" }));
});

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

export interface StagedPkg {
  readonly version: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
  /** The unique directory this module created for the staged file. */
  readonly directory: string;
}

const ensurePrivateDirectory = (fs: LocalPkgFs, path: string) =>
  Effect.gen(function* () {
    yield* fsStep("staging-failed", () => fs.mkdir(path, { recursive: true, mode: 0o700 }));
    const stat = yield* fsStep("staging-failed", () => fs.lstat(path));
    if (!stat.isDirectory() || !isOwnedByCurrentUser(stat)) {
      return yield* new LocalPkgUpdateError({ reason: "staging-failed" });
    }
    if (hasPosixPermissions && (stat.mode & 0o077) !== 0) {
      yield* fsStep("staging-failed", () => fs.chmod(path, 0o700));
    }
  });

/** Writes an attribute to a file this module owns; the read from the update folder is the source's. */
const runXattr = (args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const handle = yield* spawner.spawn(
        ChildProcess.make(XATTR_COMMAND, args, { stdin: "ignore" }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
          handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      return { stdout, stderr, exitCode: Number(exitCode) };
    }),
  ).pipe(Effect.mapError((cause) => failure("staging-failed", cause)));

/**
 * The stage copy is a byte copy, which drops extended attributes. Copying the
 * source's `com.apple.quarantine` value (when it has one) onto the staged file
 * keeps Gatekeeper's view of a downloaded package intact; this module never
 * strips or fabricates the flag. Explicit argv, no shell. A filesystem that
 * cannot hold xattrs has no flag to preserve; any other read failure aborts
 * staging rather than silently dropping the attribute.
 */
const preserveQuarantine = (source: LocalPkgSource, sourcePath: string, stagedPath: string) =>
  Effect.gen(function* () {
    const read = yield* source.readQuarantine(sourcePath);
    if (read.exitCode !== 0) {
      const noFlag =
        read.stderr.includes("No such xattr") || read.stderr.includes("Operation not supported");
      if (noFlag) return;
      return yield* new LocalPkgUpdateError({
        reason: "staging-failed",
        code: `exit-${read.exitCode}`,
      });
    }
    const value = read.stdout.trim();
    if (!QUARANTINE_VALUE.test(value) || value.startsWith("-")) {
      return yield* new LocalPkgUpdateError({ reason: "staging-failed" });
    }
    const written = yield* runXattr(["-w", QUARANTINE_ATTRIBUTE, value, stagedPath]);
    if (written.exitCode !== 0) {
      return yield* new LocalPkgUpdateError({
        reason: "staging-failed",
        code: `exit-${written.exitCode}`,
      });
    }
  });

/** Removes only a directory this module created directly under `stagingRoot`. */
export const removeStagedPackage = (input: {
  readonly stagingRoot: string;
  readonly staged: StagedPkg;
  readonly fs?: LocalPkgFs;
}) => {
  const { directory } = input.staged;
  const isOwnStageDirectory =
    NodePath.dirname(directory) === NodePath.resolve(input.stagingRoot) &&
    NodePath.basename(directory).startsWith(STAGE_DIRECTORY_PREFIX);
  return isOwnStageDirectory
    ? fsStep("staging-failed", () =>
        (input.fs ?? nodeLocalPkgFs).rm(directory, { recursive: true, force: true }),
      ).pipe(Effect.ignore)
    : Effect.void;
};

/**
 * Copies the manifest's package into a new `stage-*` directory (0700) as an
 * exclusive 0600 file. The source is opened without following symlinks and
 * must be a regular file of the declared size; bytes are hashed as they are
 * copied and the copy stops as soon as more than the declared size arrives.
 * Nothing but the self-created stage directory is ever removed, on failure
 * or interruption.
 */
export const stage = Effect.fn("desktop.updates.localPkg.stage")(function* (input: {
  readonly sourceDirectory: string;
  readonly stagingRoot: string;
  readonly manifest: LocalPkgManifest;
  readonly onProgress?: (percent: number) => Effect.Effect<void>;
  /** macOS only: carry the source's quarantine flag onto the staged copy. Defaults to true. */
  readonly preserveQuarantine?: boolean;
  /** The local side only: the staging folder and the staged file. */
  readonly fs?: LocalPkgFs;
  readonly source?: LocalPkgSource;
}) {
  const fs = input.fs ?? nodeLocalPkgFs;
  const source = input.source ?? defaultLocalPkgSource;
  const { manifest } = input;
  const stagingRoot = NodePath.resolve(input.stagingRoot);
  const sourcePath = NodePath.join(input.sourceDirectory, manifest.pkg);
  const stagedIn = (directory: string): StagedPkg => ({
    version: manifest.version,
    size: manifest.size,
    sha256: manifest.sha256,
    path: NodePath.join(directory, manifest.pkg),
    directory,
  });

  const copyInto = (staged: StagedPkg) =>
    Effect.scoped(
      Effect.gen(function* () {
        const mismatch = new LocalPkgUpdateError({ reason: "package-mismatch" });
        // A failed open or a symlink is a package that is not the published one; a failed
        // stat or read on the open file is the folder's.
        const handle = yield* source.open(sourcePath, {
          unsafe: "package-mismatch",
          unreadable: "package-mismatch",
          io: "folder-unavailable",
        });
        const sourceStat = yield* handle.stat;
        if (!sourceStat.isFile || sourceStat.size !== manifest.size) return yield* mismatch;

        const target = yield* openFile(
          fs,
          staged.path,
          EXCLUSIVE_WRITE,
          { unsafe: "staging-failed", unreadable: "staging-failed" },
          0o600,
        );
        const hash = NodeCrypto.createHash("sha256");
        let copied = 0;
        let reportedPercent = -1;
        for (;;) {
          // One byte past the declared size, so an oversized source is noticed.
          const wanted = Math.min(COPY_CHUNK_BYTES, manifest.size - copied + 1);
          const chunk = yield* handle.read(wanted);
          if (chunk.length === 0) break;
          copied += chunk.length;
          if (copied > manifest.size) return yield* mismatch;
          hash.update(chunk);
          yield* fsStep("staging-failed", async () => {
            let offset = 0;
            while (offset < chunk.length) {
              const { bytesWritten } = await target.write(chunk, offset, chunk.length - offset);
              // A write that makes no progress would otherwise loop forever.
              if (bytesWritten <= 0) {
                throw Object.assign(new Error("short write"), { code: "EIO" });
              }
              offset += bytesWritten;
            }
          });
          const percent = Math.min(99, Math.floor((copied * 100) / manifest.size));
          if (input.onProgress !== undefined && percent !== reportedPercent) {
            reportedPercent = percent;
            yield* input.onProgress(percent);
          }
        }
        if (copied !== manifest.size || hash.digest("hex") !== manifest.sha256) {
          return yield* mismatch;
        }
        yield* fsStep("staging-failed", () => target.sync());
      }),
    );

  yield* ensurePrivateDirectory(fs, stagingRoot);
  // The stage directory is a resource: created uninterruptibly and removed
  // unless the whole stage succeeds, whether it failed or was interrupted.
  return yield* Effect.acquireUseRelease(
    fsStep("staging-failed", () => fs.mkdtemp(NodePath.join(stagingRoot, STAGE_DIRECTORY_PREFIX))),
    (directory) => {
      const staged = stagedIn(directory);
      return copyInto(staged).pipe(
        Effect.andThen(
          input.preserveQuarantine === false
            ? Effect.void
            : preserveQuarantine(source, sourcePath, staged.path),
        ),
        Effect.as(staged),
      );
    },
    (directory, exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : removeStagedPackage({ stagingRoot, staged: stagedIn(directory), fs }),
  );
});

/**
 * Re-checks a staged package right before the Installer is opened: a private
 * regular file owned by this user, of the staged size, with the staged hash.
 */
export const verifyStaged = Effect.fn("desktop.updates.localPkg.verifyStaged")(function* (
  staged: StagedPkg,
  fs: LocalPkgFs = nodeLocalPkgFs,
) {
  const changed = new LocalPkgUpdateError({ reason: "staged-changed" });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* openFile(fs, staged.path, NOFOLLOW_READ, {
        unsafe: "staged-changed",
        unreadable: "staged-changed",
      });
      const stat = yield* fsStep("staged-changed", () => handle.stat());
      if (
        !stat.isFile() ||
        stat.size !== staged.size ||
        !isOwnedByCurrentUser(stat) ||
        (hasPosixPermissions && (stat.mode & 0o077) !== 0)
      ) {
        return yield* changed;
      }
      const digest = yield* fsStep("staged-changed", async () => {
        const hash = NodeCrypto.createHash("sha256");
        const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
        let total = 0;
        while (total <= staged.size) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          hash.update(buffer.subarray(0, bytesRead));
        }
        return total === staged.size ? hash.digest("hex") : null;
      });
      if (digest !== staged.sha256) return yield* changed;
    }),
  );
});

/** Hands the staged package to the macOS Installer; it asks the user to confirm. */
export const openInstaller = Effect.fn("desktop.updates.localPkg.openInstaller")(function* (
  stagedPath: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(OPEN_COMMAND, ["-b", INSTALLER_BUNDLE_ID, stagedPath], {
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        }),
      );
      return yield* handle.exitCode.pipe(Effect.timeoutOption(INSTALLER_OPEN_TIMEOUT));
    }),
  ).pipe(Effect.mapError((cause) => failure("installer-failed", cause)));
  if (Option.isNone(exitCode) || Number(exitCode.value) !== 0) {
    return yield* new LocalPkgUpdateError({
      reason: "installer-failed",
      ...(Option.isSome(exitCode) ? { code: `exit-${Number(exitCode.value)}` } : {}),
    });
  }
});

/**
 * Starts the staged Windows setup as its own process, so it keeps running after OoP quits to
 * let the installer replace the app. The setup shows its own pages and asks for confirmation.
 */
export const launchSetup = (stagedPath: string) =>
  Effect.callback<void, LocalPkgUpdateError>((resume) => {
    const child = NodeChildProcess.spawn(stagedPath, [], { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resume(Effect.void);
    });
    child.once("error", (cause) => resume(Effect.fail(failure("installer-failed", cause))));
  }).pipe(
    Effect.timeoutOption(INSTALLER_OPEN_TIMEOUT),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new LocalPkgUpdateError({ reason: "installer-failed" })),
        onSome: () => Effect.void,
      }),
    ),
    Effect.withSpan("desktop.updates.localPkg.launchSetup"),
  );
