// @effect-diagnostics nodeBuiltinImport:off - Effect has no free-space query.
import * as NodeFSP from "node:fs/promises";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const AUTO_VACUUM_INCREMENTAL = 2;
const GIB = 1024 * 1024 * 1024;

// The desktop gives the backend 1 minute to become ready
// (apps/desktop/src/backend/DesktopBackendManager.ts DEFAULT_BACKEND_READINESS_TIMEOUT),
// and a timed-out start is retried, which would roll the VACUUM back every
// time. Budget 20 s for it at a conservative 100 MB/s; larger databases skip.
export const MAX_CONVERSION_DB_BYTES = 20 * 100_000_000;

export const FREELIST_THRESHOLD_PAGES = 2048;
export const INCREMENTAL_STEP_PAGES = 2000;
const STEP_PAUSE = "50 millis";
const FIRST_RUN_DELAY = "3 minutes";
const RUN_INTERVAL = "6 hours";

/** Free bytes on the volume holding `directory`. */
export type FreeBytesProbe = (directory: string) => Effect.Effect<number>;

export const statfsFreeBytes: FreeBytesProbe = (directory) =>
  Effect.promise(async () => {
    const stats = await NodeFSP.statfs(directory, { bigint: true });
    return Number(stats.bavail * stats.bsize);
  });

const readNumber = (sql: SqlClient.SqlClient, pragma: string) =>
  sql
    .unsafe<Record<string, number>>(`PRAGMA ${pragma}`)
    .pipe(Effect.map((rows) => Number(Object.values(rows[0] ?? {})[0] ?? 0)));

/**
 * One-time switch to auto_vacuum = INCREMENTAL, which needs a full VACUUM
 * (exclusive access, ~DB size of temp space). Never fails: problems log a
 * warning and the conversion is retried on the next start.
 */
export const convertToIncrementalVacuum = (input: {
  readonly dbDirectory: string;
  readonly freeBytes?: FreeBytesProbe;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if ((yield* readNumber(sql, "auto_vacuum")) === AUTO_VACUUM_INCREMENTAL) return;

    const pageSize = yield* readNumber(sql, "page_size");
    const dbBytes = (yield* readNumber(sql, "page_count")) * pageSize;
    if (dbBytes > MAX_CONVERSION_DB_BYTES) {
      return yield* Effect.logWarning("skipping auto_vacuum conversion: database too large", {
        dbBytes,
        maxBytes: MAX_CONVERSION_DB_BYTES,
      });
    }
    const freeBytes = yield* (input.freeBytes ?? statfsFreeBytes)(input.dbDirectory);
    const requiredBytes = 2 * dbBytes + GIB;
    if (freeBytes < requiredBytes) {
      return yield* Effect.logWarning("skipping auto_vacuum conversion: not enough free disk", {
        dbBytes,
        freeBytes,
        requiredBytes,
      });
    }

    const startedAt = yield* Clock.currentTimeMillis;
    yield* sql.unsafe(`PRAGMA auto_vacuum = INCREMENTAL`);
    yield* sql.unsafe(`VACUUM`);
    const finishedAt = yield* Clock.currentTimeMillis;
    const afterBytes =
      (yield* readNumber(sql, "page_count")) * (yield* readNumber(sql, "page_size"));
    yield* Effect.logInfo("converted database to incremental auto_vacuum", {
      durationMs: finishedAt - startedAt,
      bytesBefore: dbBytes,
      bytesAfter: afterBytes,
    });
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) =>
        Effect.logWarning("auto_vacuum conversion failed; will retry next start", { cause }),
    ),
  );

/** Returns freed pages in small steps until the freelist is under the threshold. */
export const incrementalVacuumPass = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  if ((yield* readNumber(sql, "auto_vacuum")) !== AUTO_VACUUM_INCREMENTAL) return;

  let freelist = yield* readNumber(sql, "freelist_count");
  const startingFreelist = freelist;
  while (freelist > FREELIST_THRESHOLD_PAGES) {
    // The sqlite client run()s statements without result columns, which frees
    // one page per execution, so a step is N single-page calls in one transaction.
    yield* sql.withTransaction(
      Effect.forEach(
        Array.from({ length: INCREMENTAL_STEP_PAGES }),
        () => sql.unsafe(`PRAGMA incremental_vacuum(1)`),
        { discard: true },
      ),
    );
    const remaining = yield* readNumber(sql, "freelist_count");
    if (remaining >= freelist) break;
    freelist = remaining;
    // Let other writers in between steps.
    yield* Effect.sleep(STEP_PAUSE);
  }
  if (freelist < startingFreelist) {
    yield* Effect.logInfo("incremental vacuum released pages", {
      pages: startingFreelist - freelist,
    });
  }
}).pipe(
  Effect.catchCauseIf(
    (cause) => !Cause.hasInterruptsOnly(cause),
    (cause) => Effect.logWarning("incremental vacuum failed", { cause }),
  ),
);

/** Scheduled like the receipt pruning: shortly after start, then every 6 hours. */
export const periodicIncrementalVacuum = Effect.sleep(FIRST_RUN_DELAY).pipe(
  Effect.andThen(incrementalVacuumPass.pipe(Effect.repeat(Schedule.spaced(RUN_INTERVAL)))),
);
