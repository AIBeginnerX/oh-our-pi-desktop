// @effect-diagnostics nodeBuiltinImport:off -- A possibly stalled network mount is read by a child process that must be killable without waiting, which needs node:child_process and node:fs handles the Effect spawner and FileSystem do not offer.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { LocalPkgUpdateError, errnoCode, failure, type Reason } from "./LocalPkgUpdateError.ts";

/**
 * Where LocalPkgUpdates reads the update folder from. Node cannot cancel a
 * filesystem call that a stalled mount never answers, and each one keeps a libuv
 * thread and a pending promise alive for as long as the kernel holds it. So the
 * production source reads through a helper process (`LocalPkgSourceWorker`, one
 * per file) that the main process can kill: a stall costs the helper, never the
 * app. Everything else stays in the main process: the size bound, hashing, the
 * private staging target and every decision about the bytes. The helper is
 * handed one path and never sees the staging folder.
 *
 * A helper SIGKILLed while the kernel holds it in an uninterruptible wait can
 * outlive the signal. It is counted until it exits, and while one is counted new
 * work is refused with `source-timeout`, which caps a dead mount at one stuck
 * process. The app itself never waits for that exit, and a healthy retry is only
 * possible once the kernel lets the process go.
 */

export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";

/**
 * One request to the update folder gets this long before its helper is killed.
 * A check also bounds its whole manifest read by it, so a folder that answers
 * one byte at a time cannot stretch a check indefinitely.
 */
export const SOURCE_IO_TIMEOUT = Duration.seconds(30);
/** How long ending a helper may delay the caller before it is killed instead. */
const SOURCE_CLOSE_GRACE = Duration.seconds(2);
const XATTR_COMMAND = "/usr/bin/xattr";

/** Parent-to-helper requests are single JSON lines; replies are length-prefixed frames. */
export const MAX_READ_BYTES = 1024 * 1024;
const MAX_PATH_BYTES = 2048;
const MAX_REQUEST_BYTES = 4096;
const FRAME_HEADER_BYTES = 5;
const MAX_OK_BYTES = 256;
const MAX_ERR_BYTES = 128;
const MAX_REPLY_BYTES = MAX_READ_BYTES + 1024;
const XATTR_OUTPUT_CAP_BYTES = 1024;
const REPLY_OK = 1;
const REPLY_DATA = 2;
const REPLY_ERR = 3;
const ERRNO_CODE = /^[A-Z][A-Z0-9_]{0,31}$/;
const HELPER_FAILED = "helper-failed";
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const NOFOLLOW_READ =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;

export interface SourceStat {
  readonly isFile: boolean;
  readonly size: number;
}

/** One open file in the update folder. Every call is bounded by the source's I/O timeout. */
export interface SourceHandle {
  readonly stat: Effect.Effect<SourceStat, LocalPkgUpdateError>;
  /** An empty array is end of file; never longer than `length` (1 to `MAX_READ_BYTES`). */
  readonly read: (length: number) => Effect.Effect<Uint8Array, LocalPkgUpdateError>;
}

export interface SourceReasons {
  /** The path is a symlink. */
  readonly unsafe: Reason;
  /** The open failed otherwise, or the helper broke its protocol while opening. */
  readonly unreadable: Reason;
  /** A stat or read on the opened handle failed. Defaults to `unreadable`. */
  readonly io?: Reason;
}

export interface QuarantineRead {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface LocalPkgSource {
  /** Scoped: closing the scope ends the helper within the close grace and never waits longer. */
  readonly open: (
    path: string,
    reasons: SourceReasons,
  ) => Effect.Effect<SourceHandle, LocalPkgUpdateError, Scope.Scope>;
  /** `xattr -p com.apple.quarantine <path>`, with capped output and the same kill-on-timeout. */
  readonly readQuarantine: (path: string) => Effect.Effect<QuarantineRead, LocalPkgUpdateError>;
}

// ---------------------------------------------------------------------------
// Child processes that were killed but have not exited yet
// ---------------------------------------------------------------------------

const killedHelpers = new Set<object>();

/** Helpers and xattr reads that were killed and have not exited yet. */
export const killedSourceHelpers = (): number => killedHelpers.size;

const refuseWhileHelperKilled = Effect.suspend(() =>
  killedHelpers.size > 0
    ? Effect.fail(new LocalPkgUpdateError({ reason: "source-timeout" }))
    : Effect.void,
);

const quietly = (action: () => void) => {
  try {
    action();
  } catch {
    // Cleanup must never throw into the caller.
  }
};

const noop = () => {};

interface Launched {
  readonly child: NodeChildProcess.ChildProcess;
  /** SIGKILL, release the pipes and the event loop, remember the child until it exits. */
  readonly stop: () => void;
  /** Settles when the child exits or fails to start; never rejects. */
  readonly exited: Promise<void>;
  /** Exited, failed to start, or already stopped. */
  readonly isEnded: () => boolean;
}

const launch = (
  spawn: typeof NodeChildProcess.spawn,
  command: string,
  args: ReadonlyArray<string>,
  options: NodeChildProcess.SpawnOptions,
): Launched => {
  const child = spawn(command, [...args], options);
  const token = {};
  let exited = false;
  let stopped = false;
  let markExited = noop;
  const exitedPromise = new Promise<void>((resolve) => {
    markExited = () => {
      exited = true;
      killedHelpers.delete(token);
      resolve();
    };
  });
  child.on("exit", markExited);
  // A child that cannot start never emits `exit`; one that fails later has already.
  child.on("error", () => {
    if (child.pid === undefined) markExited();
  });
  const streams: ReadonlyArray<(NodeJS.EventEmitter & { destroy: () => unknown }) | null> = [
    child.stdin,
    child.stdout,
    child.stderr,
  ];
  // A pipe that breaks after the child is gone must not become an unhandled error.
  for (const stream of streams) stream?.on("error", noop);

  return {
    child,
    exited: exitedPromise,
    isEnded: () => exited || stopped,
    stop: () => {
      if (stopped) return;
      stopped = true;
      if (!exited) quietly(() => child.kill("SIGKILL"));
      for (const stream of streams) quietly(() => stream?.destroy());
      quietly(() => child.unref());
      if (!exited) killedHelpers.add(token);
    },
  };
};

// ---------------------------------------------------------------------------
// The helper protocol
// ---------------------------------------------------------------------------

type Reply =
  | { readonly type: "ok"; readonly value: Record<string, unknown> }
  | { readonly type: "data"; readonly bytes: Uint8Array }
  | { readonly type: "err"; readonly code: string };

interface PendingRequest {
  readonly expect: "ok" | "data";
  readonly maxData: number;
  readonly resolve: (reply: Reply) => void;
  readonly reject: () => void;
}

interface Helper {
  readonly launched: Launched;
  /** Rejects on any protocol violation, early exit or write failure; the helper is then killed. */
  readonly request: (message: object, expect: "ok" | "data", maxData: number) => Promise<Reply>;
  readonly stop: () => void;
}

const parseJsonObject = (bytes: Uint8Array): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const decodeReply = (kind: "ok" | "data" | "err", payload: Uint8Array): Reply | undefined => {
  if (kind === "data") return { type: "data", bytes: payload };
  const value = parseJsonObject(payload);
  if (value === undefined) return undefined;
  if (kind === "ok") return { type: "ok", value };
  const code = value.code;
  return typeof code === "string" && ERRNO_CODE.test(code) ? { type: "err", code } : undefined;
};

const startHelper = (spawn: typeof NodeChildProcess.spawn, worker: WorkerCommand): Helper => {
  const launched = launch(spawn, worker.command, worker.args, {
    // No PATH and none of the user's variables: the helper needs nothing from them.
    // Only Windows sets SystemRoot, and its processes need it to start the runtime.
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
    },
    // stderr is dropped because it could carry a path. There is no IPC channel.
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  });
  let pending: PendingRequest | undefined;
  let chunks: Array<Buffer> = [];
  let buffered = 0;
  let broken = false;

  const rejectPending = () => {
    const current = pending;
    pending = undefined;
    current?.reject();
  };
  const stop = () => {
    broken = true;
    launched.stop();
    rejectPending();
  };

  const onReplyBytes = (chunk: Buffer) => {
    if (broken) return;
    const current = pending;
    if (current === undefined) return stop();
    chunks.push(chunk);
    buffered += chunk.length;
    if (buffered > MAX_REPLY_BYTES) return stop();
    if (buffered < FRAME_HEADER_BYTES) return;
    // The header is checked before the payload is buffered, so a bad frame is refused early.
    const first = chunks[0];
    const head =
      first !== undefined && first.length >= FRAME_HEADER_BYTES ? first : Buffer.concat(chunks);
    const type = head.readUInt8(0);
    const length = head.readUInt32BE(1);
    const kind =
      type === REPLY_OK
        ? "ok"
        : type === REPLY_DATA
          ? "data"
          : type === REPLY_ERR
            ? "err"
            : undefined;
    if (kind === undefined || (kind !== "err" && kind !== current.expect)) return stop();
    const limit = kind === "ok" ? MAX_OK_BYTES : kind === "err" ? MAX_ERR_BYTES : current.maxData;
    if (length > limit) return stop();
    const total = FRAME_HEADER_BYTES + length;
    if (buffered < total) return;
    // Exactly one frame answers one request; anything more was never asked for.
    if (buffered > total) return stop();
    const reply = decodeReply(kind, Buffer.concat(chunks, buffered).subarray(FRAME_HEADER_BYTES));
    chunks = [];
    buffered = 0;
    // A payload that does not decode is a violation: `pending` is still set, so stopping rejects it.
    if (reply === undefined) return stop();
    pending = undefined;
    current.resolve(reply);
  };
  launched.child.stdout?.on("data", (chunk: Buffer) => {
    try {
      onReplyBytes(chunk);
    } catch {
      // Whatever went wrong, the request must not be left waiting for a reply that cannot come.
      stop();
    }
  });
  void launched.exited.then(() => {
    broken = true;
    rejectPending();
  });

  return {
    launched,
    stop,
    request: (message, expect, maxData) => {
      const promise = new Promise<Reply>((resolve, reject) => {
        if (broken || launched.isEnded() || pending !== undefined) {
          reject(new Error("helper unavailable"));
          return;
        }
        pending = { expect, maxData, resolve, reject: () => reject(new Error("helper failed")) };
        launched.child.stdin?.write(`${encodeRequest(message)}\n`, (error) => {
          if (error) stop();
        });
      });
      // The caller may have been interrupted already; a late rejection is not unhandled.
      promise.catch(noop);
      return promise;
    },
  };
};

/**
 * Ends a helper that is done: EOF on stdin makes it close its file and exit,
 * and one that has not exited within the grace is killed. Nothing waits for an
 * exit without that bound, and a helper already killed is not waited for at all.
 */
const closeHelper = (helper: Helper, closeGrace: Duration.Duration) =>
  Effect.suspend(() => {
    if (helper.launched.isEnded()) return Effect.sync(helper.stop);
    quietly(() => helper.launched.child.stdin?.end());
    return Effect.promise(() => helper.launched.exited).pipe(
      Effect.timeoutOption(closeGrace),
      Effect.asVoid,
      Effect.ensuring(Effect.sync(helper.stop)),
      Effect.interruptible,
    );
  });

interface Exchange<A> {
  readonly helper: Helper;
  readonly ioTimeout: Duration.Duration;
  readonly message: object;
  readonly expect: "ok" | "data";
  readonly maxData: number;
  /** The reason for an error the helper reported, or for a helper that broke (no code). */
  readonly reasonFor: (code: string | undefined) => Reason;
  /** `undefined` means the reply was the wrong shape: a protocol violation. */
  readonly parse: (reply: Exclude<Reply, { readonly type: "err" }>) => A | undefined;
}

/**
 * One request and its reply, bounded by the I/O timeout. Interruption, the
 * timeout and any protocol violation all kill the whole helper; a late reply is
 * discarded with it.
 */
const exchange = <A>(input: Exchange<A>) =>
  Effect.suspend(() =>
    Effect.tryPromise({
      try: () => input.helper.request(input.message, input.expect, input.maxData),
      catch: () =>
        new LocalPkgUpdateError({ reason: input.reasonFor(undefined), code: HELPER_FAILED }),
    }),
  ).pipe(
    Effect.onInterrupt(() => Effect.sync(input.helper.stop)),
    Effect.timeoutOption(input.ioTimeout),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(new LocalPkgUpdateError({ reason: "source-timeout" })),
        onSome: (reply) => {
          if (reply.type === "err") {
            return Effect.fail(
              new LocalPkgUpdateError({ reason: input.reasonFor(reply.code), code: reply.code }),
            );
          }
          const parsed = input.parse(reply);
          if (parsed !== undefined) return Effect.succeed(parsed);
          input.helper.stop();
          return Effect.fail(
            new LocalPkgUpdateError({ reason: input.reasonFor(undefined), code: HELPER_FAILED }),
          );
        },
      }),
    ),
  );

const isStat = (value: Record<string, unknown>): value is { isFile: boolean; size: number } =>
  typeof value.isFile === "boolean" &&
  typeof value.size === "number" &&
  Number.isSafeInteger(value.size) &&
  value.size >= 0;

const isSymlinkErrno = (code: string | undefined) => code === "ELOOP" || code === "EMLINK";

const makeHandle = (helper: Helper, ioTimeout: Duration.Duration, io: Reason): SourceHandle => {
  const reasonFor = () => io;
  return {
    stat: exchange({
      helper,
      ioTimeout,
      message: { op: "stat" },
      expect: "ok",
      maxData: 0,
      reasonFor,
      parse: (reply): SourceStat | undefined =>
        reply.type === "ok" && isStat(reply.value)
          ? { isFile: reply.value.isFile, size: reply.value.size }
          : undefined,
    }),
    read: (length) =>
      Number.isInteger(length) && length >= 1 && length <= MAX_READ_BYTES
        ? exchange({
            helper,
            ioTimeout,
            message: { op: "read", length },
            expect: "data",
            maxData: length,
            reasonFor,
            parse: (reply) => (reply.type === "data" ? reply.bytes : undefined),
          })
        : Effect.fail(new LocalPkgUpdateError({ reason: io, code: HELPER_FAILED })),
  };
};

// ---------------------------------------------------------------------------
// Quarantine attribute read
// ---------------------------------------------------------------------------

/** Output is capped, so a runaway child cannot grow the parent's memory. */
const collectOutput = (launched: Launched): Promise<QuarantineRead> =>
  new Promise((resolve, reject) => {
    const out: Array<Buffer> = [];
    const err: Array<Buffer> = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      action();
    };
    const overflow = () =>
      settle(() => {
        launched.stop();
        reject(new Error());
      });
    launched.child.stdout?.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > XATTR_OUTPUT_CAP_BYTES) return overflow();
      out.push(chunk);
    });
    launched.child.stderr?.on("data", (chunk: Buffer) => {
      errBytes += chunk.length;
      if (errBytes > XATTR_OUTPUT_CAP_BYTES) return overflow();
      err.push(chunk);
    });
    launched.child.once("error", () => settle(() => reject(new Error())));
    launched.child.once("close", (code: number | null) =>
      settle(() => {
        if (code === null) return reject(new Error());
        resolve({
          exitCode: code,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
      }),
    );
  });

const readQuarantineWith = (
  spawn: typeof NodeChildProcess.spawn,
  command: string,
  ioTimeout: Duration.Duration,
  path: string,
) =>
  Effect.gen(function* () {
    yield* refuseWhileHelperKilled;
    const failed = () => new LocalPkgUpdateError({ reason: "staging-failed", code: HELPER_FAILED });
    // The child and every listener that watches it are registered in one
    // uninterruptible step, and the release below runs on any exit, so no
    // interruption can leave an xattr process running without an owner.
    const result = yield* Effect.acquireUseRelease(
      Effect.try({
        try: () => {
          const launched = launch(spawn, command, ["-p", QUARANTINE_ATTRIBUTE, path], {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          });
          const output = collectOutput(launched);
          output.catch(noop);
          return { launched, output };
        },
        catch: failed,
      }),
      ({ output }) =>
        Effect.tryPromise({ try: () => output, catch: failed }).pipe(
          Effect.timeoutOption(ioTimeout),
        ),
      // A child that already exited needs nothing; a running one (timeout, interruption) is killed.
      ({ launched }) => Effect.sync(launched.stop),
    );
    if (Option.isNone(result)) return yield* new LocalPkgUpdateError({ reason: "source-timeout" });
    return result.value;
  });

// ---------------------------------------------------------------------------
// The sources
// ---------------------------------------------------------------------------

export interface WorkerCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface ChildProcessSourceOptions {
  /** Tests only: the helper to run instead of the default one. */
  readonly workerCommand?: WorkerCommand;
  /** Tests only: the program to run instead of `/usr/bin/xattr`. */
  readonly xattrCommand?: string;
  /** Tests only: the per-request timeout (30 seconds). */
  readonly ioTimeout?: Duration.Duration;
  /** Tests only: how long ending a helper may take before it is killed (2 seconds). */
  readonly closeGrace?: Duration.Duration;
  /** Tests only: a stand-in for `child_process.spawn`. */
  readonly spawn?: typeof NodeChildProcess.spawn;
}

/**
 * In the main bundle the helper sits next to it (`dist-electron/updates`) and
 * runs through the same ELECTRON_RUN_AS_NODE runtime as the app's other workers.
 * From source (tests, plain Node) its TypeScript sits next to this file and
 * Node strips the types. Resolved on first use so importing this module never
 * needs it.
 */
const defaultWorker = (): WorkerCommand => {
  const filename =
    typeof __filename === "string" ? __filename : NodeURL.fileURLToPath(import.meta.url);
  const directory = NodePath.dirname(filename);
  return {
    command: process.execPath,
    args: [
      NodePath.extname(filename) === ".cjs"
        ? NodePath.join(directory, "updates", "LocalPkgSourceWorker.cjs")
        : NodePath.join(directory, "LocalPkgSourceWorker.ts"),
    ],
  };
};

const isRequestablePath = (path: string) =>
  NodePath.isAbsolute(path) && !path.includes("\0") && Buffer.byteLength(path) <= MAX_PATH_BYTES;

export const makeChildProcessSource = (options: ChildProcessSourceOptions = {}): LocalPkgSource => {
  const spawn = options.spawn ?? NodeChildProcess.spawn;
  const ioTimeout = options.ioTimeout ?? SOURCE_IO_TIMEOUT;
  const closeGrace = options.closeGrace ?? SOURCE_CLOSE_GRACE;

  const open: LocalPkgSource["open"] = (path, reasons) =>
    // Spawning and registering the finalizer are one uninterruptible step, so a
    // helper is never left without its owner; only the wait for the reply is
    // interruptible, and ending it kills the helper.
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* refuseWhileHelperKilled;
        const unreadable = (code: string) =>
          new LocalPkgUpdateError({ reason: reasons.unreadable, code });
        if (!isRequestablePath(path)) return yield* unreadable("ENAMETOOLONG");
        const request = { op: "open", path };
        if (Buffer.byteLength(`${encodeRequest(request)}\n`) > MAX_REQUEST_BYTES) {
          return yield* unreadable("ENAMETOOLONG");
        }
        const helper = yield* Effect.try({
          try: () => startHelper(spawn, options.workerCommand ?? defaultWorker()),
          catch: () => unreadable(HELPER_FAILED),
        });
        yield* Effect.addFinalizer(() => closeHelper(helper, closeGrace));
        yield* restore(
          exchange({
            helper,
            ioTimeout,
            message: request,
            expect: "ok",
            maxData: 0,
            reasonFor: (code) => (isSymlinkErrno(code) ? reasons.unsafe : reasons.unreadable),
            parse: (reply) => (reply.type === "ok" ? true : undefined),
          }),
        );
        return makeHandle(helper, ioTimeout, reasons.io ?? reasons.unreadable);
      }),
    );

  return {
    open,
    readQuarantine: (path) =>
      readQuarantineWith(spawn, options.xattrCommand ?? XATTR_COMMAND, ioTimeout, path),
  };
};

/** The source used when none is injected. The helper is only started when a check or stage needs it. */
export const defaultLocalPkgSource: LocalPkgSource = makeChildProcessSource();

/**
 * Test seam: reads through a `LocalPkgFs` in this process, so tests can break
 * individual filesystem calls. It keeps the per-call timeout and the bounded
 * close but, having no helper to kill, no cap on stalled work and no
 * accounting. Never a default.
 */
export const makeInProcessSourceForTests = (
  fs: Pick<typeof NodeFSP, "open">,
  options: {
    readonly ioTimeout?: Duration.Duration;
    readonly closeGrace?: Duration.Duration;
    readonly readQuarantine?: LocalPkgSource["readQuarantine"];
  } = {},
): LocalPkgSource => {
  const ioTimeout = options.ioTimeout ?? SOURCE_IO_TIMEOUT;
  const closeGrace = options.closeGrace ?? SOURCE_CLOSE_GRACE;
  const timed = <A>(effect: Effect.Effect<A, LocalPkgUpdateError>) =>
    effect.pipe(
      Effect.timeoutOption(ioTimeout),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new LocalPkgUpdateError({ reason: "source-timeout" })),
          onSome: Effect.succeed,
        }),
      ),
    );
  return {
    open: (path, reasons) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const opening = fs.open(path, NOFOLLOW_READ);
          // A late rejection with nobody waiting must not surface as an unhandled one.
          opening.catch(noop);
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => opening.then((handle) => handle.close().catch(noop), noop)).pipe(
              Effect.timeoutOption(closeGrace),
              Effect.interruptible,
              Effect.asVoid,
            ),
          );
          const handle = yield* restore(
            timed(
              Effect.tryPromise({
                try: () => opening,
                catch: (cause) =>
                  failure(
                    isSymlinkErrno(errnoCode(cause)) ? reasons.unsafe : reasons.unreadable,
                    cause,
                  ),
              }),
            ),
          );
          const io = reasons.io ?? reasons.unreadable;
          return {
            stat: timed(
              Effect.tryPromise({
                try: () => handle.stat(),
                catch: (cause) => failure(io, cause),
              }),
            ).pipe(Effect.map((stat): SourceStat => ({ isFile: stat.isFile(), size: stat.size }))),
            read: (length: number) =>
              timed(
                Effect.tryPromise({
                  try: async () => {
                    const buffer = Buffer.allocUnsafe(length);
                    const { bytesRead } = await handle.read(buffer, 0, length, null);
                    return buffer.subarray(0, bytesRead);
                  },
                  catch: (cause) => failure(io, cause),
                }),
              ),
          } satisfies SourceHandle;
        }),
      ),
    readQuarantine:
      options.readQuarantine ??
      (() =>
        Effect.succeed({
          exitCode: 1,
          stdout: "",
          stderr: `xattr: No such xattr: ${QUARANTINE_ATTRIBUTE}`,
        })),
  };
};
