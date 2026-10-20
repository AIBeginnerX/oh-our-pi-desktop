// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MessageId,
  ProjectId,
  ProjectMemoryId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceSqlError } from "./Errors.ts";
import { runMigrations } from "./Migrations.ts";
import { ProjectMemoryRepository, layer as projectMemoriesLayer } from "./ProjectMemories.ts";
import {
  type CommitProjectMemoryDispatchInput,
  type ProjectMemorySendCommitResult,
  ProjectMemorySendLedger,
  layer as sendLedgerLayer,
} from "./ProjectMemorySendLedger.ts";

// Race oracles for the send ledger against the real T5a memory repository.
// Ordering claims are asserted only around successful mutations: a failed
// cross-client write (SQLITE_BUSY, lost writer race) is a valid outcome whose
// rollback is proven from durable state instead. Ordering inside a test comes
// from the client permit, a fiber interruption, or SQLite's writer lock —
// never from sleeps or polling.

const NOW_ISO = "2026-10-11T09:00:00.000Z";
const LATER_ISO = "2026-10-11T10:00:00.000Z";
const TOMBSTONED_ISO = "2026-10-11T09:30:00.000Z";
const NOW = DateTime.makeUnsafe(NOW_ISO);
const FAR_FUTURE = DateTime.makeUnsafe("2036-10-11T09:00:00.000Z");

type RaceServices =
  | ProjectMemorySendLedger
  | ProjectMemoryRepository
  | Crypto.Crypto
  | SqlClient.SqlClient;
type RaceContext = Context.Context<RaceServices>;

// Seeded bytes give every ledger built over this layer a stable, distinct
// ownerInstanceId without reaching into internals.
const ownerCryptoLayer = (ownerSeed: number): Layer.Layer<Crypto.Crypto> => {
  let state = ownerSeed >>> 0;
  return Layer.succeed(
    Crypto.Crypto,
    Crypto.make({
      randomBytes: (size) => {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 1) {
          state = (Math.imul(state, 1103515245) + 12345) >>> 0;
          bytes[i] = state & 0xff;
        }
        return bytes;
      },
      digest: (_algorithm, data) => Effect.succeed(data),
    }),
  );
};

// One full stack per simulated owner: each build owns its connection, its
// statement semaphore, and its owner-instance id. Two builds over one file are
// two independent SQLite clients, like two server processes.
const clientStack = (dbPath: string, ownerSeed: number) =>
  Layer.mergeAll(sendLedgerLayer, projectMemoriesLayer).pipe(
    Layer.provideMerge(ownerCryptoLayer(ownerSeed)),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: dbPath })),
  );

function withRaceClients<A, E>(
  run: (dbPath: string, clientA: RaceContext, clientB: RaceContext) => Effect.Effect<A, E, never>,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-send-ledger-race-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  return Effect.scoped(
    Effect.gen(function* () {
      const clientA = yield* Layer.build(clientStack(dbPath, 1));
      const clientB = yield* Layer.build(clientStack(dbPath, 2));
      return yield* run(dbPath, clientA, clientB);
    }),
  ).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
}

const test = (
  name: string,
  run: (
    dbPath: string,
    clientA: RaceContext,
    clientB: RaceContext,
  ) => Effect.Effect<unknown, unknown, never>,
  timeout?: number,
) => it.effect(name, () => withRaceClients(run), timeout);

const onClient = <A, E, R>(client: RaceContext, effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, client);

// Production connection setup, applied per simulated server process.
const setPragmas = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA busy_timeout = 5000`;
  yield* sql`PRAGMA journal_mode = WAL`;
});

const seedProject = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW_ISO}, ${NOW_ISO}, NULL)
    `;
  });

const seedThread = (projectId: string, threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at, deleted_at
      )
      VALUES (${threadId}, ${projectId}, 'Thread', '{}', 'full-access', 'default',
        ${NOW_ISO}, ${NOW_ISO}, NULL)
    `;
  });

const seedMessage = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${threadId}, NULL, 'user', 'text', 0, ${NOW_ISO}, ${NOW_ISO})
    `;
  });

const memoryInput = (overrides: {
  readonly memoryId: string;
  readonly origin?:
    | { readonly type: "manual" }
    | { readonly type: "message"; readonly threadId: string; readonly messageId: string };
}) => ({
  memoryId: ProjectMemoryId.make(overrides.memoryId),
  projectId: ProjectId.make("project-1"),
  kind: "fact" as const,
  title: "Deploy runbook",
  body: "Restart the server",
  origin:
    overrides.origin === undefined || overrides.origin.type === "manual"
      ? ({ type: "manual" } as const)
      : {
          type: "message" as const,
          threadId: ThreadId.make(overrides.origin.threadId),
          messageId: MessageId.make(overrides.origin.messageId),
        },
  // Non-expiring is the common real shape; the committed case below proves the
  // null bypass explicitly.
  validUntil: null,
  estimatedTokens: 10,
  now: NOW_ISO,
});

const memoryUpdateInput = (overrides: {
  readonly memoryId: string;
  readonly expectedVersion: number;
}) => ({
  projectId: ProjectId.make("project-1"),
  memoryId: ProjectMemoryId.make(overrides.memoryId),
  expectedVersion: overrides.expectedVersion,
  title: "Deploy runbook v2",
  body: "Run migrations, restart, then warm the cache",
  kind: "procedure" as const,
  validUntil: null,
  estimatedTokens: 12,
  now: LATER_ISO,
});

const commitInput = (overrides: {
  readonly threadId: string;
  readonly messageId: string;
  readonly items: ReadonlyArray<{ readonly memoryId: string; readonly selectedVersion: number }>;
  readonly now?: DateTime.Utc;
}): CommitProjectMemoryDispatchInput => ({
  threadId: ThreadId.make(overrides.threadId),
  messageId: MessageId.make(overrides.messageId),
  projectId: ProjectId.make("project-1"),
  providerInstanceId: ProviderInstanceId.make("pi"),
  items: overrides.items.map((item) => ({
    memoryId: ProjectMemoryId.make(item.memoryId),
    selectedVersion: item.selectedVersion,
  })),
  now: overrides.now ?? NOW,
});

// Durable-state readers for what the ledger API does not expose: attempt and
// item rows and the memory row's version.
const attemptCountFor = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS "n" FROM project_memory_send_attempts
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
    `;
    return rows[0]?.n ?? -1;
  });

const allAttemptCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly n: number }>`
    SELECT COUNT(*) AS "n" FROM project_memory_send_attempts
  `;
  return rows[0]?.n ?? -1;
});

const itemCountFor = (memoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly n: number }>`
      SELECT COUNT(*) AS "n" FROM project_memory_send_items WHERE memory_id = ${memoryId}
    `;
    return rows[0]?.n ?? -1;
  });

const memoryVersionFor = (memoryId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{ readonly version: number }>`
      SELECT version FROM project_memories WHERE memory_id = ${memoryId}
    `;
  });

describe("ProjectMemorySendLedger races", () => {
  test(
    "commits a non-expiring memory saved from a live user message, visible across clients",
    (_dbPath, clientA, clientB) =>
      Effect.gen(function* () {
        const ledger = Context.get(clientA, ProjectMemorySendLedger);
        const memories = Context.get(clientA, ProjectMemoryRepository);
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
            yield* seedThread("project-1", "thread-1");
            yield* seedMessage("thread-1", "message-1");
          }),
        );

        const inserted = yield* onClient(
          clientA,
          memories.insert(
            memoryInput({
              memoryId: "pos-mem-1",
              origin: { type: "message", threadId: "thread-1", messageId: "message-1" },
            }),
          ),
        );
        if (inserted.status !== "applied")
          return assert.fail("expected the memory insert to apply");

        // validUntil null means no expiry: even a far-future now must commit.
        const committed = yield* onClient(
          clientA,
          ledger.commitDispatch(
            commitInput({
              threadId: "thread-1",
              messageId: "message-1",
              items: [{ memoryId: "pos-mem-1", selectedVersion: 1 }],
              now: FAR_FUTURE,
            }),
          ),
        );
        if (committed.status !== "committed") {
          return assert.fail(`expected committed, got ${JSON.stringify(committed)}`);
        }
        assert.ok(Number.isSafeInteger(committed.attemptSeq));
        assert.ok(committed.attemptSeq >= 1);

        const loaded = yield* onClient(
          clientA,
          memories.getById({
            projectId: ProjectId.make("project-1"),
            memoryId: ProjectMemoryId.make("pos-mem-1"),
          }),
        );
        assert.isTrue(Option.isSome(loaded));
        const record = Option.getOrThrow(loaded);
        assert.deepEqual(committed.memories, [
          {
            memoryId: record.memoryId,
            version: record.version,
            kind: record.kind,
            title: record.title,
            body: record.body,
          },
        ]);

        // A second independent client already sees the durable rows.
        yield* onClient(clientB, setPragmas);
        assert.equal(yield* onClient(clientB, attemptCountFor("thread-1", "message-1")), 1);
        assert.equal(yield* onClient(clientB, itemCountFor("pos-mem-1")), 1);
      }),
    60_000,
  );

  test(
    "R1 shared client: a commit/delete race ends committed-with-one-deleted-row or rejected-with-none",
    (_dbPath, clientA, clientB) =>
      Effect.gen(function* () {
        const ledger = Context.get(clientA, ProjectMemorySendLedger);
        const memories = Context.get(clientA, ProjectMemoryRepository);
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
          }),
        );

        let committedRounds = 0;
        for (let round = 0; round < 20; round += 1) {
          const threadId = `r1-thread-${round}`;
          const messageId = `r1-message-${round}`;
          const memoryId = `r1-mem-${round}`;
          yield* onClient(
            clientA,
            Effect.gen(function* () {
              yield* seedThread("project-1", threadId);
              yield* seedMessage(threadId, messageId);
            }),
          );
          const inserted = yield* onClient(clientA, memories.insert(memoryInput({ memoryId })));
          assert.equal(inserted.status, "applied");

          // Both sides share one client, so its connection permit serializes
          // the two transactions and SQLite commit order alone decides.
          const [admission, deletion] = yield* Effect.all(
            [
              onClient(
                clientA,
                ledger.commitDispatch(
                  commitInput({
                    threadId,
                    messageId,
                    items: [{ memoryId, selectedVersion: 1 }],
                  }),
                ),
              ),
              onClient(
                clientA,
                memories.delete({
                  projectId: ProjectId.make("project-1"),
                  memoryId: ProjectMemoryId.make(memoryId),
                  expectedVersion: 1,
                }),
              ),
            ],
            { concurrency: "unbounded" },
          );

          assert.deepEqual(deletion, { status: "applied" });
          if (admission.status === "committed") {
            committedRounds += 1;
            assert.deepEqual(admission.memories, [
              {
                memoryId: ProjectMemoryId.make(memoryId),
                version: 1,
                kind: "fact",
                title: "Deploy runbook",
                body: "Restart the server",
              },
            ]);
            assert.equal(yield* onClient(clientA, attemptCountFor(threadId, messageId)), 1);
            assert.equal(yield* onClient(clientA, itemCountFor(memoryId)), 1);
            // change_seq is table-global across rounds: assert this round's own
            // exposure row and that it is also the thread's latest.
            const state = yield* onClient(
              clientA,
              ledger.affectedState({ threadId: ThreadId.make(threadId), limit: 50 }),
            );
            assert.equal(state.held, true);
            assert.equal(state.ackedThrough, 0);
            assert.equal(state.changes.length, 1);
            assert.equal(state.changes[0]?.reason, "deleted");
            assert.equal(state.changes[0]?.memoryId, ProjectMemoryId.make(memoryId));
            assert.ok(Number.isSafeInteger(state.changes[0]?.changeSeq));
            assert.equal(state.latestChangeSeq, state.changes[0]?.changeSeq);
          } else {
            // The delete committed first: the admission holds unavailable and
            // records nothing at all.
            assert.deepEqual(admission, { status: "held", reason: "unavailable" });
            assert.equal(yield* onClient(clientA, attemptCountFor(threadId, messageId)), 0);
            const state = yield* onClient(
              clientA,
              ledger.affectedState({ threadId: ThreadId.make(threadId), limit: 50 }),
            );
            assert.isFalse(state.held);
            assert.equal(state.latestChangeSeq, null);
          }
        }

        // Both connections agree on the total number of durable attempts.
        yield* onClient(clientB, setPragmas);
        assert.equal(yield* onClient(clientB, allAttemptCount), committedRounds);
      }),
    60_000,
  );

  test(
    "R2 prior history: a stale-version admission and an update land in the I5 outcomes, body always v1",
    (_dbPath, clientA, _clientB) =>
      Effect.gen(function* () {
        const ledger = Context.get(clientA, ProjectMemorySendLedger);
        const memories = Context.get(clientA, ProjectMemoryRepository);
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
            yield* seedThread("project-1", "thread-1");
            yield* seedMessage("thread-1", "message-1");
            yield* seedMessage("thread-1", "message-2");
          }),
        );
        const inserted = yield* onClient(
          clientA,
          memories.insert(memoryInput({ memoryId: "r2-mem-1" })),
        );
        assert.equal(inserted.status, "applied");

        // Prior history: this thread already carries a v1 attempt.
        const prior = yield* onClient(
          clientA,
          ledger.commitDispatch(
            commitInput({
              threadId: "thread-1",
              messageId: "message-1",
              items: [{ memoryId: "r2-mem-1", selectedVersion: 1 }],
            }),
          ),
        );
        assert.equal(prior.status, "committed");

        const [admission, update] = yield* Effect.all(
          [
            onClient(
              clientA,
              ledger.commitDispatch(
                commitInput({
                  threadId: "thread-1",
                  messageId: "message-2",
                  items: [{ memoryId: "r2-mem-1", selectedVersion: 1 }],
                }),
              ),
            ),
            onClient(
              clientA,
              memories.update(memoryUpdateInput({ memoryId: "r2-mem-1", expectedVersion: 1 })),
            ),
          ],
          { concurrency: "unbounded" },
        );

        // The admission never touches the memory row, so the update cannot
        // lose its expectedVersion here.
        if (update.status !== "applied") return assert.fail("expected the update to apply");
        assert.equal(update.record.version, 2);

        if (admission.status === "committed") {
          // Admission won: the returned body is the pre-update v1 content.
          assert.deepEqual(admission.memories, [
            {
              memoryId: ProjectMemoryId.make("r2-mem-1"),
              version: 1,
              kind: "fact",
              title: "Deploy runbook",
              body: "Restart the server",
            },
          ]);
          assert.equal(yield* onClient(clientA, attemptCountFor("thread-1", "message-2")), 1);
        } else {
          // Update won: the admission requesting the pre-mutation v1 is stale.
          assert.deepEqual(admission, { status: "held", reason: "version-changed" });
          assert.equal(yield* onClient(clientA, attemptCountFor("thread-1", "message-2")), 0);
        }

        // Either order leaves exactly the update's own exposure row behind.
        const state = yield* onClient(
          clientA,
          ledger.affectedState({ threadId: ThreadId.make("thread-1"), limit: 50 }),
        );
        assert.equal(state.held, true);
        assert.equal(state.latestChangeSeq, 1);
        assert.equal(state.changes.length, 1);
        assert.equal(state.changes[0]?.reason, "updated");
        assert.equal(state.changes[0]?.memoryId, ProjectMemoryId.make("r2-mem-1"));
      }),
    60_000,
  );

  test(
    "R3 independent clients: concurrent same-message commits admit at most one body, one row",
    (_dbPath, clientA, clientB) =>
      Effect.gen(function* () {
        const ledgerA = Context.get(clientA, ProjectMemorySendLedger);
        const ledgerB = Context.get(clientB, ProjectMemorySendLedger);
        const memories = Context.get(clientA, ProjectMemoryRepository);
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
            yield* seedThread("project-1", "thread-1");
            yield* seedMessage("thread-1", "message-1");
          }),
        );
        const inserted = yield* onClient(
          clientA,
          memories.insert(memoryInput({ memoryId: "r3-mem-1" })),
        );
        assert.equal(inserted.status, "applied");
        yield* onClient(clientB, setPragmas);

        // Both Exits are captured: the loser may fail (BUSY, UNIQUE) or hold
        // already-committed, and only the durable row adjudicates.
        const [exitA, exitB] = yield* Effect.all(
          [
            Effect.exit(
              onClient(
                clientA,
                ledgerA.commitDispatch(
                  commitInput({
                    threadId: "thread-1",
                    messageId: "message-1",
                    items: [{ memoryId: "r3-mem-1", selectedVersion: 1 }],
                  }),
                ),
              ),
            ),
            Effect.exit(
              onClient(
                clientB,
                ledgerB.commitDispatch(
                  commitInput({
                    threadId: "thread-1",
                    messageId: "message-1",
                    items: [{ memoryId: "r3-mem-1", selectedVersion: 1 }],
                  }),
                ),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

        const committedResults: Extract<ProjectMemorySendCommitResult, { status: "committed" }>[] =
          [];
        for (const exit of [exitA, exitB]) {
          if (Exit.isSuccess(exit)) {
            if (exit.value.status === "committed") {
              committedResults.push(exit.value);
            } else {
              assert.deepEqual(exit.value, { status: "held", reason: "already-committed" });
            }
            continue;
          }
          const failure = Cause.findErrorOption(exit.cause);
          if (failure._tag !== "Some" || !(failure.value instanceof PersistenceSqlError)) {
            return assert.fail("expected a refined PersistenceSqlError from the losing commit");
          }
        }

        assert.ok(committedResults.length <= 1);
        for (const committed of committedResults) {
          assert.ok(Number.isSafeInteger(committed.attemptSeq));
          assert.ok(committed.attemptSeq >= 1);
          assert.equal(committed.memories.length, 1);
          assert.equal(committed.memories[0]?.memoryId, ProjectMemoryId.make("r3-mem-1"));
          assert.equal(committed.memories[0]?.version, 1);
        }
        // Durable uniqueness: exactly the committed results own rows, and both
        // independent connections agree on the count.
        assert.equal(
          yield* onClient(clientA, attemptCountFor("thread-1", "message-1")),
          committedResults.length,
        );
        assert.equal(
          yield* onClient(clientB, attemptCountFor("thread-1", "message-1")),
          committedResults.length,
        );
        assert.equal(yield* onClient(clientB, itemCountFor("r3-mem-1")), committedResults.length);
      }),
    120_000,
  );

  test(
    "R3 independent clients: commit vs delete ordering claims apply only to a successful deletion",
    (_dbPath, clientA, clientB) =>
      Effect.gen(function* () {
        const ledgerA = Context.get(clientA, ProjectMemorySendLedger);
        const ledgerB = Context.get(clientB, ProjectMemorySendLedger);
        const memoriesA = Context.get(clientA, ProjectMemoryRepository);
        const memoriesB = Context.get(clientB, ProjectMemoryRepository);
        const threadId = "thread-1";
        const messageId = "message-1";
        const memoryId = "r3-mem-1";
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
            yield* seedThread("project-1", threadId);
            yield* seedMessage(threadId, messageId);
          }),
        );
        const inserted = yield* onClient(clientA, memoriesA.insert(memoryInput({ memoryId })));
        assert.equal(inserted.status, "applied");
        yield* onClient(clientB, setPragmas);

        const [admissionExit, deletionExit] = yield* Effect.all(
          [
            Effect.exit(
              onClient(
                clientA,
                ledgerA.commitDispatch(
                  commitInput({
                    threadId,
                    messageId,
                    items: [{ memoryId, selectedVersion: 1 }],
                  }),
                ),
              ),
            ),
            Effect.exit(
              onClient(
                clientB,
                memoriesB.delete({
                  projectId: ProjectId.make("project-1"),
                  memoryId: ProjectMemoryId.make(memoryId),
                  expectedVersion: 1,
                }),
              ),
            ),
          ],
          { concurrency: "unbounded" },
        );

        const deletionApplied =
          Exit.isSuccess(deletionExit) && deletionExit.value.status === "applied";
        const admission = Exit.isSuccess(admissionExit) ? admissionExit.value : undefined;

        if (deletionApplied) {
          if (admission?.status === "committed") {
            // Delete followed a committed admission: exactly one exposure row.
            assert.equal(admission.memories[0]?.version, 1);
            assert.equal(yield* onClient(clientB, attemptCountFor(threadId, messageId)), 1);
            const state = yield* onClient(
              clientB,
              ledgerB.affectedState({ threadId: ThreadId.make(threadId), limit: 50 }),
            );
            assert.equal(state.latestChangeSeq, 1);
            assert.equal(state.changes.length, 1);
            assert.equal(state.changes[0]?.reason, "deleted");
          } else if (admission?.status === "held") {
            // Delete committed first: unavailable hold, nothing recorded.
            assert.deepEqual(admission, { status: "held", reason: "unavailable" });
            assert.equal(yield* onClient(clientB, attemptCountFor(threadId, messageId)), 0);
            const state = yield* onClient(
              clientB,
              ledgerB.affectedState({ threadId: ThreadId.make(threadId), limit: 50 }),
            );
            assert.equal(state.latestChangeSeq, null);
          } else {
            // The admission lost the writer lock and failed; the delete won.
            assert.equal(yield* onClient(clientB, attemptCountFor(threadId, messageId)), 0);
            const state = yield* onClient(
              clientB,
              ledgerB.affectedState({ threadId: ThreadId.make(threadId), limit: 50 }),
            );
            assert.equal(state.latestChangeSeq, null);
          }
        } else {
          // A failed delete must roll back: the memory row survives untouched,
          // and no deletion/affected guarantee is claimed.
          const versions = yield* onClient(clientB, memoryVersionFor(memoryId));
          assert.equal(versions.length, 1);
          assert.equal(versions[0]?.version, 1);
          if (admission?.status === "committed") {
            assert.equal(admission.memories[0]?.version, 1);
            assert.equal(yield* onClient(clientA, attemptCountFor(threadId, messageId)), 1);
          } else if (admission !== undefined) {
            // The memory never vanished, so an unavailable hold is impossible
            // against a rolled-back delete.
            return assert.fail(`unexpected held admission: ${JSON.stringify(admission)}`);
          } else {
            assert.equal(yield* onClient(clientA, attemptCountFor(threadId, messageId)), 0);
          }
        }
      }),
    120_000,
  );

  test(
    "R4 owner handoff: reconcile converts a live sibling owner and its late settle is already-final",
    (_dbPath, clientA, clientB) =>
      Effect.gen(function* () {
        const ledgerA = Context.get(clientA, ProjectMemorySendLedger);
        const ledgerB = Context.get(clientB, ProjectMemorySendLedger);
        const memoriesA = Context.get(clientA, ProjectMemoryRepository);
        const memoriesB = Context.get(clientB, ProjectMemoryRepository);
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
            yield* seedThread("project-1", "thread-1");
            yield* seedMessage("thread-1", "message-1");
          }),
        );
        const inserted = yield* onClient(
          clientA,
          memoriesA.insert(memoryInput({ memoryId: "r4-mem-1" })),
        );
        assert.equal(inserted.status, "applied");

        const committed = yield* onClient(
          clientA,
          ledgerA.commitDispatch(
            commitInput({
              threadId: "thread-1",
              messageId: "message-1",
              items: [{ memoryId: "r4-mem-1", selectedVersion: 1 }],
            }),
          ),
        );
        if (committed.status !== "committed") return assert.fail("expected committed");

        // The second owner instance reconciles: the still-pending sibling row
        // converts even though owner A is alive.
        assert.deepEqual(yield* onClient(clientB, ledgerB.reconcileOtherOwners({ now: NOW })), {
          converted: 1,
        });

        // Owner A's late settle finds its row final and still owned by it.
        assert.deepEqual(
          yield* onClient(
            clientA,
            ledgerA.settle({
              attemptSeq: committed.attemptSeq,
              outcome: "provider_accepted",
              now: NOW,
            }),
          ),
          { status: "already-final", state: "external_send_unknown" },
        );

        // Exposure evidence still accumulates: the delete lands afterwards.
        const deleted = yield* onClient(
          clientB,
          memoriesB.delete({
            projectId: ProjectId.make("project-1"),
            memoryId: ProjectMemoryId.make("r4-mem-1"),
            expectedVersion: 1,
          }),
        );
        assert.deepEqual(deleted, { status: "applied" });
        const state = yield* onClient(
          clientB,
          ledgerB.affectedState({ threadId: ThreadId.make("thread-1"), limit: 50 }),
        );
        assert.equal(state.held, true);
        assert.equal(state.latestChangeSeq, 1);
        assert.equal(state.changes[0]?.reason, "deleted");
      }),
    60_000,
  );

  test(
    "R5 thread recreation: the ledger stays with the thread id and a new id starts clean",
    (_dbPath, clientA, _clientB) =>
      Effect.gen(function* () {
        const ledger = Context.get(clientA, ProjectMemorySendLedger);
        const memories = Context.get(clientA, ProjectMemoryRepository);
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
            yield* seedThread("project-1", "thread-1");
            yield* seedMessage("thread-1", "message-1");
          }),
        );
        const inserted = yield* onClient(
          clientA,
          memories.insert(memoryInput({ memoryId: "r5-mem-1" })),
        );
        assert.equal(inserted.status, "applied");

        const committed = yield* onClient(
          clientA,
          ledger.commitDispatch(
            commitInput({
              threadId: "thread-1",
              messageId: "message-1",
              items: [{ memoryId: "r5-mem-1", selectedVersion: 1 }],
            }),
          ),
        );
        if (committed.status !== "committed") return assert.fail("expected committed");

        // Leave exposure history on the thread before the recreation cycle.
        const updated = yield* onClient(
          clientA,
          memories.update(memoryUpdateInput({ memoryId: "r5-mem-1", expectedVersion: 1 })),
        );
        if (updated.status !== "applied") return assert.fail("expected the update to apply");

        yield* onClient(
          clientA,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_threads SET deleted_at = ${TOMBSTONED_ISO} WHERE thread_id = 'thread-1'`;
          }),
        );

        // The uniqueness hold is checked before identity: the tombstoned
        // thread's admission still holds already-committed with no body.
        const whileDead = yield* onClient(
          clientA,
          ledger.commitDispatch(
            commitInput({
              threadId: "thread-1",
              messageId: "message-1",
              items: [{ memoryId: "r5-mem-1", selectedVersion: 2 }],
            }),
          ),
        );
        assert.deepEqual(whileDead, { status: "held", reason: "already-committed" });

        // Recreate the same thread id and try again.
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_threads SET deleted_at = NULL WHERE thread_id = 'thread-1'`;
          }),
        );
        const recreated = yield* onClient(
          clientA,
          ledger.commitDispatch(
            commitInput({
              threadId: "thread-1",
              messageId: "message-1",
              items: [{ memoryId: "r5-mem-1", selectedVersion: 2 }],
            }),
          ),
        );
        assert.deepEqual(recreated, { status: "held", reason: "already-committed" });
        assert.equal(yield* onClient(clientA, attemptCountFor("thread-1", "message-1")), 1);

        // The old exposure history survived the recreation untouched.
        const oldState = yield* onClient(
          clientA,
          ledger.affectedState({ threadId: ThreadId.make("thread-1"), limit: 50 }),
        );
        assert.equal(oldState.held, true);
        assert.equal(oldState.latestChangeSeq, 1);
        assert.equal(oldState.ackedThrough, 0);
        assert.deepEqual(oldState.changes, [
          { changeSeq: 1, memoryId: ProjectMemoryId.make("r5-mem-1"), reason: "updated" },
        ]);

        // A genuinely new thread id carries no ledger state and commits cleanly.
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* seedThread("project-1", "thread-2");
            yield* seedMessage("thread-2", "message-2");
          }),
        );
        const freshState = yield* onClient(
          clientA,
          ledger.affectedState({ threadId: ThreadId.make("thread-2"), limit: 50 }),
        );
        assert.deepEqual(freshState, {
          held: false,
          latestChangeSeq: null,
          ackedThrough: 0,
          changes: [],
        });
        const freshCommit = yield* onClient(
          clientA,
          ledger.commitDispatch(
            commitInput({
              threadId: "thread-2",
              messageId: "message-2",
              items: [{ memoryId: "r5-mem-1", selectedVersion: 2 }],
            }),
          ),
        );
        assert.equal(freshCommit.status, "committed");
      }),
    60_000,
  );

  test(
    "R6 interruption: nothing before COMMIT, durable rows after it, exposure still recorded",
    (_dbPath, clientA, clientB) =>
      Effect.gen(function* () {
        const ledgerA = Context.get(clientA, ProjectMemorySendLedger);
        const memoriesA = Context.get(clientA, ProjectMemoryRepository);
        const memoriesB = Context.get(clientB, ProjectMemoryRepository);
        const threadId = "thread-1";
        const messageId = "message-1";
        const memoryId = "r6-mem-1";
        const input = commitInput({
          threadId,
          messageId,
          items: [{ memoryId, selectedVersion: 1 }],
        });
        yield* onClient(
          clientA,
          Effect.gen(function* () {
            yield* setPragmas;
            yield* runMigrations();
            yield* seedProject("project-1");
            yield* seedThread("project-1", threadId);
            yield* seedMessage(threadId, messageId);
          }),
        );
        const inserted = yield* onClient(clientA, memoriesA.insert(memoryInput({ memoryId })));
        assert.equal(inserted.status, "applied");
        yield* onClient(clientB, setPragmas);

        // Pre-commit: hold SQLite's writer lock on the independent connection
        // so the forked commit cannot reach COMMIT, then interrupt its fiber.
        // The held lock makes "nothing durable" true regardless of fiber
        // scheduling, and the scope releases the lock (a COMMIT of the empty
        // lock transaction) on success, failure, or interruption. This proves
        // only that an interruption landing before any commit persists
        // nothing — it does not observe an in-flight COMMIT or excuse one.
        const sqlB = Context.get(clientB, SqlClient.SqlClient);
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              sqlB`BEGIN IMMEDIATE`,
              // Teardown-grade: a failed COMMIT of the empty lock transaction
              // means the environment is broken, so it dies instead of flowing
              // into the error channel. The finalizer still runs on every exit.
              () => Effect.orDie(sqlB`COMMIT`),
            );
            const fiber = yield* Effect.forkChild(onClient(clientA, ledgerA.commitDispatch(input)));
            yield* Fiber.interrupt(fiber);
          }),
        );

        assert.equal(yield* onClient(clientA, attemptCountFor(threadId, messageId)), 0);
        assert.equal(yield* onClient(clientA, itemCountFor(memoryId)), 0);
        const preState = yield* onClient(
          clientA,
          ledgerA.affectedState({ threadId: ThreadId.make(threadId), limit: 50 }),
        );
        assert.equal(preState.latestChangeSeq, null);

        // Post-commit: the result only returns after the top-level COMMIT, so
        // an interruption from that point cannot take the row back.
        const exit = yield* Effect.gen(function* () {
          const committed = yield* onClient(clientA, ledgerA.commitDispatch(input));
          if (committed.status !== "committed") return assert.fail("expected committed");
          yield* Effect.interrupt;
        }).pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));
        assert.isTrue(Exit.hasInterrupts(exit));

        assert.equal(yield* onClient(clientB, attemptCountFor(threadId, messageId)), 1);
        assert.equal(yield* onClient(clientB, itemCountFor(memoryId)), 1);

        // The later delete still records exposure for the interrupted owner.
        const deleted = yield* onClient(
          clientB,
          memoriesB.delete({
            projectId: ProjectId.make("project-1"),
            memoryId: ProjectMemoryId.make(memoryId),
            expectedVersion: 1,
          }),
        );
        assert.deepEqual(deleted, { status: "applied" });
        const postState = yield* onClient(
          clientB,
          ledgerA.affectedState({ threadId: ThreadId.make(threadId), limit: 50 }),
        );
        assert.equal(postState.held, true);
        assert.equal(postState.changes.length, 1);
        assert.equal(postState.changes[0]?.reason, "deleted");
      }),
    120_000,
  );
});
