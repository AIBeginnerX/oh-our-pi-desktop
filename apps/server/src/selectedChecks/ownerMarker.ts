import { Sha256Hex, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * The on-disk owner marker for one thread's selected-checks slot.
 *
 * `readMarker` classifies whatever bytes are present without believing them:
 * only ENOENT is `absent`, any other read failure is `unreadable`, and
 * oversized, empty, non-JSON, or schema-mismatch content is `corrupt` with the
 * sha256 of the bytes actually read.
 *
 * `transitionMarker` is a read-modify-write under the caller's serialization
 * permit — it is not a lock. The expectation is checked against the read
 * before anything is written; `free` accepts absent or released, `exact`
 * accepts any observed bytes whose sha256 matches. The replace is ordered
 * temp `wx 0o600` → write → fsync → close → rename → directory fsync (EPERM
 * tolerated). `applied` is reported only when every step succeeded and the
 * file re-reads with the sha256 of the written bytes; any other outcome is
 * `uncertain` and carries the actual post-attempt observation — callers must
 * not infer that an uncertain transition preserved the old bytes.
 *
 * Durability claim: on a healthy OS the marker survives a server-process
 * restart. No power-loss or cross-process guarantee is made.
 */
export const OWNER_MARKER_FILE = "selected-checks-owner.json";

/** Bytes beyond this bound are never a marker — the file is corrupt. */
export const OWNER_MARKER_MAX_BYTES = 4_096;

const SafePositiveInt = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);

export const OwnedMarker = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("owned"),
  attemptId: Schema.String,
  threadId: ThreadId,
  scriptId: Schema.NullOr(Schema.String),
  pgid: Schema.NullOr(SafePositiveInt),
  writtenAt: Schema.String,
});
export type OwnedMarker = typeof OwnedMarker.Type;

export const ReleasedMarker = Schema.Struct({
  version: Schema.Literal(1),
  state: Schema.Literal("released"),
  how: Schema.Literals(["groups-gone", "gone-observed", "acknowledged"]),
  previousSha256: Sha256Hex,
  previous: Schema.NullOr(
    Schema.Struct({
      attemptId: Schema.String,
      threadId: ThreadId,
      scriptId: Schema.NullOr(Schema.String),
      pgid: Schema.NullOr(SafePositiveInt),
    }),
  ),
  releasedAt: Schema.String,
});
export type ReleasedMarker = typeof ReleasedMarker.Type;

export const OwnerMarker = Schema.Union([OwnedMarker, ReleasedMarker]);
export type OwnerMarker = typeof OwnerMarker.Type;

export type MarkerRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | { readonly kind: "corrupt"; readonly sha256: Sha256Hex; readonly bytes: number }
  | { readonly kind: "owned"; readonly sha256: Sha256Hex; readonly marker: OwnedMarker }
  | { readonly kind: "released"; readonly sha256: Sha256Hex; readonly marker: ReleasedMarker };

export type MarkerExpectation =
  /** The marker is absent or released — no owned claim on disk. */
  | { readonly kind: "free" }
  /** The marker bytes observed sha256 exactly — including corrupt bytes. */
  | { readonly kind: "exact"; readonly sha256: Sha256Hex };

export type MarkerTransition =
  | { readonly kind: "applied"; readonly sha256: Sha256Hex }
  | { readonly kind: "rejected"; readonly observed: MarkerRead }
  | { readonly kind: "uncertain"; readonly observed: MarkerRead };

const decodeMarker = Schema.decodeUnknownOption(Schema.fromJsonString(OwnerMarker));
const encodeMarker = Schema.encodeSync(Schema.fromJsonString(OwnerMarker));

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};

const toHex = (bytes: Uint8Array): string => {
  const digits = "0123456789abcdef";
  let hex = "";
  for (const byte of bytes) hex += digits.charAt(byte >> 4) + digits.charAt(byte & 15);
  return hex;
};

// A platform crypto fault is an unrecoverable defect here — it produces no
// marker classification and no secret content.
const sha256Hex = Effect.fnUntraced(function* (
  bytes: Uint8Array,
): Effect.fn.Return<Sha256Hex, never, Crypto.Crypto> {
  const crypto = yield* Crypto.Crypto;
  return yield* crypto.digest("SHA-256", bytes).pipe(Effect.map(toHex), Effect.orDie);
});

export const readMarker = Effect.fnUntraced(function* (
  markerPath: string,
): Effect.fn.Return<MarkerRead, never, FileSystem.FileSystem | Crypto.Crypto> {
  const fs = yield* FileSystem.FileSystem;
  const read = yield* Effect.result(fs.readFile(markerPath));
  if (Result.isFailure(read)) {
    return { kind: read.failure.reason._tag === "NotFound" ? "absent" : "unreadable" };
  }
  const bytes = read.success;
  const sha256 = yield* sha256Hex(bytes);
  if (bytes.length === 0 || bytes.length > OWNER_MARKER_MAX_BYTES) {
    return { kind: "corrupt", sha256, bytes: bytes.length };
  }
  const text = decodeUtf8(bytes);
  const marker = text === null ? Option.none() : decodeMarker(text);
  return Option.match(marker, {
    onNone: (): MarkerRead => ({ kind: "corrupt", sha256, bytes: bytes.length }),
    onSome: (marker): MarkerRead =>
      marker.state === "owned"
        ? { kind: "owned", sha256, marker }
        : { kind: "released", sha256, marker },
  });
});

const expectationMatches = (expect: MarkerExpectation, observed: MarkerRead): boolean =>
  expect.kind === "free"
    ? observed.kind === "absent" || observed.kind === "released"
    : observed.kind !== "absent" &&
      observed.kind !== "unreadable" &&
      observed.sha256 === expect.sha256;

// A directory fsync reporting EPERM keeps the rename durable enough — any
// other failure makes the replace's confirmation incomplete.
const isErrnoCode = (error: PlatformError.PlatformError, code: string): boolean =>
  typeof error.reason.cause === "object" &&
  error.reason.cause !== null &&
  "code" in error.reason.cause &&
  error.reason.cause.code === code;

export const transitionMarker = Effect.fnUntraced(function* (
  markerPath: string,
  expect: MarkerExpectation,
  next: OwnerMarker,
): Effect.fn.Return<MarkerTransition, never, FileSystem.FileSystem | Path.Path | Crypto.Crypto> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const observedBefore = yield* readMarker(markerPath);
  if (!expectationMatches(expect, observedBefore)) {
    return { kind: "rejected", observed: observedBefore };
  }

  const bytes = new TextEncoder().encode(encodeMarker(next));
  if (bytes.length > OWNER_MARKER_MAX_BYTES) {
    // Refuse before any write — the encoded bytes can never read back as a
    // marker, so reporting an applied replace would be false.
    return { kind: "rejected", observed: observedBefore };
  }
  const writtenSha256 = yield* sha256Hex(bytes);
  const tempPath = `${markerPath}.tmp.${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;

  // ownedTemp arms the cleanup obligation: the exclusive wx create and the
  // flag are one uninterruptible handoff, so no pending interrupt can be
  // delivered between the file's creation and recording that this invocation
  // owns it — and a failed wx (EEXIST or otherwise) never authorizes
  // unlinking a path this invocation did not create. The release runs on
  // every non-success exit — typed failure, defect and interruption alike —
  // but not after a completed rename, when tempPath no longer exists and the
  // target must not be touched.
  let ownedTemp = false;
  const replaced = yield* Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const file = yield* Effect.uninterruptible(
          Effect.map(fs.open(tempPath, { flag: "wx", mode: 0o600 }), (opened) => {
            ownedTemp = true;
            return opened;
          }),
        );
        yield* file.writeAll(bytes);
        yield* file.sync;
      }),
    );
    yield* fs.rename(tempPath, markerPath);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const dir = yield* fs.open(path.dirname(markerPath), { flag: "r" });
        yield* dir.sync.pipe(
          Effect.catch((error) => (isErrnoCode(error, "EPERM") ? Effect.void : Effect.fail(error))),
        );
      }),
    );
  }).pipe(
    Effect.onExit((exit) =>
      ownedTemp && !Exit.isSuccess(exit)
        ? fs.remove(tempPath, { force: true }).pipe(Effect.ignore)
        : Effect.void,
    ),
    Effect.result,
  );

  const observed = yield* readMarker(markerPath);
  return Result.isSuccess(replaced) &&
    (observed.kind === "owned" || observed.kind === "released") &&
    observed.marker.state === next.state &&
    observed.sha256 === writtenSha256
    ? { kind: "applied", sha256: writtenSha256 }
    : { kind: "uncertain", observed };
});
