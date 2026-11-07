// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { makeSqlitePersistenceLive, SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import {
  FREELIST_THRESHOLD_PAGES,
  convertToIncrementalVacuum,
  incrementalVacuumPass,
} from "./SqliteMaintenance.ts";

const ROWS = 3000;
const HUGE = 1e15;

// A file DB with the legacy auto_vacuum = NONE and a large freelist.
const makeLegacyDb = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-maint-"));
  const dbPath = NodePath.join(dir, "state.sqlite");
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE junk(payload BLOB)");
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS})
    INSERT INTO junk(payload) SELECT randomblob(3000) FROM n`);
  db.exec("DELETE FROM junk");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  return { dir, dbPath, size: () => NodeFS.statSync(dbPath).size };
};

const rawClient = (dbPath: string) =>
  NodeSqliteClient.layer({ filename: dbPath }).pipe(Layer.provide(NodeServices.layer));

const pragma = (name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql.unsafe<Record<string, number>>(`PRAGMA ${name}`);
    return Number(Object.values(rows[0] ?? {})[0]);
  });

const cleanup = (dir: string) =>
  Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

const convert = (dir: string, dbPath: string, freeBytes: number) =>
  convertToIncrementalVacuum({ dbDirectory: dir, freeBytes: () => Effect.succeed(freeBytes) }).pipe(
    Effect.provide(rawClient(dbPath)),
  );

const autoVacuumOf = (dbPath: string) =>
  pragma("auto_vacuum").pipe(Effect.provide(rawClient(dbPath)));

it.effect("converts a legacy file DB to incremental auto_vacuum and shrinks it", () => {
  const { dir, dbPath, size } = makeLegacyDb();
  const before = size();
  return Effect.gen(function* () {
    assert.equal(yield* autoVacuumOf(dbPath), 0);
    yield* convert(dir, dbPath, HUGE);
    assert.equal(yield* autoVacuumOf(dbPath), 2);
    assert.isBelow(size(), before / 10);
  }).pipe(Effect.ensuring(cleanup(dir)));
});

it.effect("converts at startup through the persistence layer", () => {
  const { dir, dbPath, size } = makeLegacyDb();
  const before = size();
  return Effect.gen(function* () {
    assert.equal(yield* pragma("auto_vacuum"), 2);
  }).pipe(
    Effect.provide(
      makeSqlitePersistenceLive(dbPath, {
        maintenance: { freeBytes: () => Effect.succeed(HUGE) },
      }).pipe(Layer.provide(NodeServices.layer)),
    ),
    Effect.tap(() => Effect.sync(() => assert.isBelow(size(), before))),
    Effect.ensuring(cleanup(dir)),
  );
});

it.effect("leaves the database alone without maintenance, as CLI commands open it", () => {
  const { dir, dbPath, size } = makeLegacyDb();
  const before = size();
  return Effect.gen(function* () {
    assert.equal(yield* pragma("auto_vacuum"), 0);
  }).pipe(
    Effect.provide(makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.tap(() => Effect.sync(() => assert.equal(size(), before))),
    Effect.ensuring(cleanup(dir)),
  );
});

it.effect("skips the VACUUM when free disk is below 2 x DB + 1 GiB", () => {
  const { dir, dbPath, size } = makeLegacyDb();
  const before = size();
  return Effect.gen(function* () {
    yield* convert(dir, dbPath, before * 2 + 1024 ** 3 - 1);
    assert.equal(size(), before);
    assert.equal(yield* autoVacuumOf(dbPath), 0);
    // Exactly enough space proceeds.
    yield* convert(dir, dbPath, before * 2 + 1024 ** 3);
    assert.isBelow(size(), before);
  }).pipe(Effect.ensuring(cleanup(dir)));
});

it.effect("skips :memory: databases", () =>
  Effect.gen(function* () {
    // Memory persistence never wires maintenance; auto_vacuum stays NONE.
    assert.equal(yield* pragma("auto_vacuum"), 0);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("does not VACUUM when already incremental", () => {
  const { dir, dbPath } = makeLegacyDb();
  return Effect.gen(function* () {
    yield* convert(dir, dbPath, HUGE);
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE t(p BLOB); INSERT INTO t VALUES (randomblob(30000)); DELETE FROM t;");
    db.close();
    const before = NodeFS.statSync(dbPath).size;
    let probed = false;
    yield* convertToIncrementalVacuum({
      dbDirectory: dir,
      freeBytes: () =>
        Effect.sync(() => {
          probed = true;
          return HUGE;
        }),
    }).pipe(Effect.provide(rawClient(dbPath)));
    assert.isFalse(probed);
    assert.equal(NodeFS.statSync(dbPath).size, before);
  }).pipe(Effect.ensuring(cleanup(dir)));
});

it.live("incremental pass shrinks the freelist below the threshold", () => {
  const { dir, dbPath, size } = makeLegacyDb();
  return Effect.gen(function* () {
    yield* convert(dir, dbPath, HUGE);
    const db = new NodeSqlite.DatabaseSync(dbPath);
    db.exec("CREATE TABLE t(p BLOB)");
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS * 2})
      INSERT INTO t SELECT randomblob(3000) FROM n`);
    db.exec("DELETE FROM t");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
    const before = size();
    yield* Effect.gen(function* () {
      assert.isAbove(yield* pragma("freelist_count"), FREELIST_THRESHOLD_PAGES);
      yield* incrementalVacuumPass;
      assert.isAtMost(yield* pragma("freelist_count"), FREELIST_THRESHOLD_PAGES);
    }).pipe(Effect.provide(rawClient(dbPath)));
    assert.isBelow(size(), before);
  }).pipe(Effect.ensuring(cleanup(dir)));
});

it.effect("a VACUUM blocked by another writer logs and does not fail", () => {
  const { dir, dbPath, size } = makeLegacyDb();
  const before = size();
  const holder = new NodeSqlite.DatabaseSync(dbPath);
  holder.exec("BEGIN IMMEDIATE");
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA busy_timeout = 100`;
    yield* convertToIncrementalVacuum({
      dbDirectory: dir,
      freeBytes: () => Effect.succeed(HUGE),
    });
    assert.equal(size(), before);
  }).pipe(
    Effect.provide(rawClient(dbPath)),
    Effect.ensuring(
      Effect.sync(() => {
        holder.exec("ROLLBACK");
        holder.close();
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }),
    ),
  );
});
