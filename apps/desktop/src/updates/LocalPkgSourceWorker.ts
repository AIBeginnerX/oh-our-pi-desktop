// @effect-diagnostics nodeBuiltinImport:off -- Standalone Node child with no Effect runtime: it exists only to own one file descriptor on a possibly stalled mount.
/**
 * Helper process for LocalPkgSource. It opens one file read-only without
 * following symlinks and serves `stat` and `read` on it, so a mount that stops
 * answering stalls this process and never the app. The parent kills it with
 * SIGKILL on any timeout; nothing here retries, validates package contents or
 * touches anything but that one descriptor.
 *
 * Requests arrive on stdin as one JSON line each (`open`, then `stat` and
 * `read`), one at a time. Every reply is a frame on stdout:
 * `[type u8][length u32 BE][payload]` with type 1 `ok` (JSON), 2 `data` (raw
 * bytes, empty at end of file) or 3 `err` (JSON `{ code }`). The parent
 * enforces the limits; any request that breaks them ends this process, and no
 * reply ever contains a path. EOF on stdin closes the file and exits.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MAX_REQUEST_BYTES = 4096;
const MAX_PATH_BYTES = 2048;
const MAX_READ_BYTES = 1024 * 1024;
const REPLY_OK = 1;
const REPLY_DATA = 2;
const REPLY_ERR = 3;

const NOFOLLOW_READ =
  NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK;

let descriptor: number | undefined;
let opened = false;
let pending = Buffer.alloc(0);

const quit = (status: number): never => {
  process.exit(status);
};

const reply = (type: number, payload: Uint8Array) => {
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt8(type, 0);
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  process.stdout.write(frame);
};

const replyJson = (type: number, value: unknown) => {
  reply(type, Buffer.from(JSON.stringify(value)));
};

const replyError = (cause: unknown) => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "EIO";
  replyJson(REPLY_ERR, { code });
};

const handle = (line: string) => {
  let request: unknown;
  try {
    request = JSON.parse(line);
  } catch {
    return quit(2);
  }
  if (typeof request !== "object" || request === null || !("op" in request)) return quit(2);

  if (request.op === "open") {
    const path = "path" in request ? request.path : undefined;
    if (
      opened ||
      typeof path !== "string" ||
      // win32 rules accept POSIX roots as well as drive and UNC paths (\\host\share\...).
      !NodePath.win32.isAbsolute(path) ||
      path.includes("\0") ||
      Buffer.byteLength(path) > MAX_PATH_BYTES
    ) {
      return quit(2);
    }
    opened = true;
    try {
      descriptor = NodeFS.openSync(path, NOFOLLOW_READ);
      replyJson(REPLY_OK, {});
    } catch (cause) {
      replyError(cause);
    }
    return;
  }

  if (descriptor === undefined) return quit(2);

  if (request.op === "stat") {
    try {
      const stat = NodeFS.fstatSync(descriptor);
      replyJson(REPLY_OK, { isFile: stat.isFile(), size: stat.size });
    } catch (cause) {
      replyError(cause);
    }
    return;
  }

  const length = request.op === "read" && "length" in request ? request.length : undefined;
  if (!Number.isInteger(length) || typeof length !== "number" || length < 1) return quit(2);
  if (length > MAX_READ_BYTES) return quit(2);
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytesRead = NodeFS.readSync(descriptor, buffer, 0, length, null);
    reply(REPLY_DATA, buffer.subarray(0, bytesRead));
  } catch (cause) {
    replyError(cause);
  }
};

process.stdout.on("error", () => quit(1));
process.stdin.on("error", () => quit(1));
process.stdin.on("end", () => {
  try {
    if (descriptor !== undefined) NodeFS.closeSync(descriptor);
  } catch {
    // The parent only needs the exit; a failed close has nobody to tell.
  }
  quit(0);
});
process.stdin.on("data", (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk]);
  const newline = pending.indexOf(0x0a);
  if (newline === -1) {
    if (pending.length > MAX_REQUEST_BYTES) quit(2);
    return;
  }
  // The parent sends the next request only after this one's reply.
  if (newline > MAX_REQUEST_BYTES || newline !== pending.length - 1) quit(2);
  const line = pending.subarray(0, newline).toString("utf8");
  pending = Buffer.alloc(0);
  handle(line);
});
