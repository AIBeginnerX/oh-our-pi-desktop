import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import { ServerConfig } from "../../config.ts";
import {
  convertToIncrementalVacuum,
  periodicIncrementalVacuum,
  type FreeBytesProbe,
} from "../SqliteMaintenance.ts";

// Size the -wal file is cut back to on the first commit after a WAL reset.
export const WAL_SIZE_LIMIT_BYTES = 32 * 1024 * 1024;

const makeSetup = (file?: { readonly dbDirectory: string; readonly freeBytes?: FreeBytesProbe }) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      // CLI and server write from separate processes; wait rather than fail with SQLITE_BUSY.
      yield* sql`PRAGMA busy_timeout = 5000;`;
      yield* sql`PRAGMA foreign_keys = ON;`;
      yield* sql`PRAGMA journal_mode = WAL;`;
      // PASSIVE checkpoints never shrink the -wal file, so it otherwise keeps its
      // largest size until the last connection closes.
      yield* sql.unsafe(`PRAGMA journal_size_limit = ${WAL_SIZE_LIMIT_BYTES};`);
      yield* runMigrations();
      if (file) {
        // Before the server reports ready: the VACUUM needs exclusive access.
        yield* convertToIncrementalVacuum({
          dbDirectory: file.dbDirectory,
          ...(file.freeBytes ? { freeBytes: file.freeBytes } : {}),
        });
        yield* Effect.forkScoped(periodicIncrementalVacuum);
      }
    }),
  );

const setup = makeSetup();

export const makeSqlitePersistenceLive = Effect.fn("makeSqlitePersistenceLive")(function* (
  dbPath: string,
  /** Database upkeep (VACUUM); only the long-running server asks for it, see `serverLayerConfig`. */
  options?: { readonly maintenance?: { readonly freeBytes?: FreeBytesProbe } },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });

  return Layer.provideMerge(
    dbPath === ":memory:" || options?.maintenance === undefined
      ? setup
      : makeSetup({
          dbDirectory: path.dirname(dbPath),
          ...(options.maintenance.freeBytes ? { freeBytes: options.maintenance.freeBytes } : {}),
        }),
    NodeSqliteClient.layer({
      filename: dbPath,
      spanAttributes: {
        "db.name": path.basename(dbPath),
        "service.name": "t3code-server",
      },
    }),
  );
}, Layer.unwrap);

export const SqlitePersistenceMemory = Layer.provideMerge(
  setup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);

export const layerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath);
  }),
);

/**
 * The server's persistence: `layerConfig` plus database upkeep. CLI commands keep `layerConfig`,
 * since they open the same file while the server runs and a VACUUM there would hold the write lock
 * against the server.
 */
export const serverLayerConfig = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig;
    return makeSqlitePersistenceLive(dbPath, { maintenance: {} });
  }),
);
