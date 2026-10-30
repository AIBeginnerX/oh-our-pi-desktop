// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MessageId,
  PROJECT_MEMORY_PENDING_PROPOSALS_MAX,
  PROJECT_MEMORY_THREAD_CHANGES_MAX,
  ProjectId,
  ProjectMemoryId,
  ProjectMemoryNotFoundError,
  type ProjectMemoryCreateInput,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { PersistenceSqlError, type ProjectMemoryRepositoryError } from "../persistence/Errors.ts";
import { ProjectionProjectRepositoryLive } from "../persistence/Layers/ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "../persistence/Layers/ProjectionThreads.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { layer as projectMemoriesLayer } from "../persistence/ProjectMemories.ts";
import {
  PROJECT_MEMORY_AFFECTED_PAGE_MAX,
  type ProjectMemoryAffectedState,
  type ProjectMemorySendAcknowledgeResult,
  ProjectMemorySendLedger,
  layer as sendLedgerLayer,
} from "../persistence/ProjectMemorySendLedger.ts";
import {
  ProjectionThreadRepository,
  type ProjectionThread,
  type ProjectionThreadRepositoryShape,
} from "../persistence/Services/ProjectionThreads.ts";
import {
  ProjectMemoryService,
  layer as projectMemoryServiceLayer,
} from "./ProjectMemoryService.ts";

const NOW = "2026-10-09T00:00:00.000Z";

const encodeStoreError = Schema.encodeSync(ProjectMemoryStoreError);

interface ThreadReadGate {
  readonly parked: Deferred.Deferred<Option.Option<ProjectionThread>>;
  readonly gate: Deferred.Deferred<void>;
}

interface LedgerFault {
  readonly method: "affectedState" | "acknowledge";
  readonly effect: unknown;
}

interface TestHooks {
  threadReadGate: ThreadReadGate | undefined;
  ledgerFault: LedgerFault | undefined;
}

// One fresh file database per test on ONE shared connection: the memory
// repository, the real send ledger, and the real thread/project projection
// repositories all consume the same SqlClient, which is exported to the test
// body for seeding and inspection. No second engine is ever created.
// NodeServices is provided into the service consumer (not merged as a
// sibling) so its Crypto requirement resolves where it is used.
//
// The opt-in wrappers keep the real services in the stack: the thread-repo
// gate parks holding the caller's transaction only after the real `getById`
// completed (S6), and the ledger fault swaps one method's outcome for a
// foreign failure (S9/S9′). Both are passthrough until a test sets them.
function withMemoryStack<A, E, R>(
  run: (
    hooks: TestHooks,
    dbPath: string,
  ) => Effect.Effect<
    A,
    E,
    R | ProjectMemoryService | ProjectMemorySendLedger | SqlClient.SqlClient
  >,
) {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-memory-service-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const hooks: TestHooks = { threadReadGate: undefined, ledgerFault: undefined };

  const sqlite = NodeSqliteClient.layer({ filename: dbPath });
  const dependencies = Layer.mergeAll(
    projectMemoriesLayer,
    Layer.effect(
      ProjectMemorySendLedger,
      Effect.gen(function* () {
        const real = yield* ProjectMemorySendLedger;
        return {
          commitDispatch: (input) => real.commitDispatch(input),
          // The fence pair delegates to the same real instance, so a
          // service update/delete bumps the counters tests capture.
          captureMutationFence: () => real.captureMutationFence(),
          mutationFenceHolds: (fence) => real.mutationFenceHolds(fence),
          withMemoryMutation: (effect) => real.withMemoryMutation(effect),
          revalidateDispatch: (input) => real.revalidateDispatch(input),
          settle: (input) => real.settle(input),
          reconcileOtherOwners: (input) => real.reconcileOtherOwners(input),
          affectedState: (input) =>
            hooks.ledgerFault?.method === "affectedState"
              ? (hooks.ledgerFault.effect as Effect.Effect<
                  ProjectMemoryAffectedState,
                  ProjectMemoryRepositoryError
                >)
              : real.affectedState(input),
          acknowledge: (input) =>
            hooks.ledgerFault?.method === "acknowledge"
              ? (hooks.ledgerFault.effect as Effect.Effect<
                  ProjectMemorySendAcknowledgeResult,
                  ProjectMemoryRepositoryError
                >)
              : real.acknowledge(input),
        } satisfies ProjectMemorySendLedger["Service"];
      }),
    ).pipe(Layer.provide(sendLedgerLayer)),
    Layer.effect(
      ProjectionThreadRepository,
      Effect.gen(function* () {
        const real = yield* ProjectionThreadRepository;
        return {
          upsert: (row) => real.upsert(row),
          getById: (input) =>
            Effect.flatMap(real.getById(input), (row) => {
              const hook = hooks.threadReadGate;
              if (hook === undefined) return Effect.succeed(row);
              // `row` is the real read's Option — publish it as the receipt.
              return Effect.flatMap(Deferred.succeed(hook.parked, row), () =>
                Deferred.await(hook.gate),
              ).pipe(Effect.as(row));
            }),
        } satisfies ProjectionThreadRepositoryShape;
      }),
    ).pipe(Layer.provide(ProjectionThreadRepositoryLive)),
    ProjectionProjectRepositoryLive,
  ).pipe(Layer.provideMerge(sqlite));
  const service = projectMemoryServiceLayer.pipe(
    Layer.provide(dependencies),
    Layer.provide(NodeServices.layer),
  );

  return Effect.gen(function* () {
    yield* Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.mergeAll(dependencies, service));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          // WAL matches the production file setup and lets S6's second
          // independent client commit while the first holds a read snapshot.
          yield* sql`PRAGMA journal_mode = WAL`;
          yield* sql`PRAGMA foreign_keys = ON`;
          yield* sql`PRAGMA busy_timeout = 5000`;
        }).pipe(Effect.provide(context));
        return yield* run(hooks, dbPath).pipe(Effect.provide(context));
      }),
    ).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  });
}

const test = (
  name: string,
  run: (
    hooks: TestHooks,
    dbPath: string,
  ) => Effect.Effect<
    unknown,
    unknown,
    ProjectMemoryService | ProjectMemorySendLedger | SqlClient.SqlClient
  >,
) => it.effect(name, () => withMemoryStack(run));

// A second, independently opened client on the same file for race fixtures.
const runWithClient = <A, E, R>(
  dbPath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) =>
  Effect.scoped(
    Effect.flatMap(Layer.build(NodeSqliteClient.layer({ filename: dbPath })), (context) =>
      Effect.provide(effect, context),
    ),
  );

// Markers planted in every injected ledger fault. No sanitized result may
// render any of them, in any form.
const INJECTED_SECRETS = [
  "SECRET-OP",
  "SECRET-DETAIL",
  "SECRET-CAUSE",
  "SECRET-DEFECT",
  "SECRET-STORE",
  "SECRET-REJ",
];

// Proves the faulty effect itself executed: the counter ticks inside the
// injected effect, immediately before its failure, so assigning the hook or
// merely selecting the method can never satisfy a case.
interface FaultReceipt {
  count: number;
}

const injectedFault = <A, E>(
  receipt: FaultReceipt,
  effect: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  Effect.flatMap(
    Effect.sync(() => {
      receipt.count += 1;
    }),
    () => effect,
  );

// Every injected failure must leave the service as one freshly sanitized
// store error: fixed message, and no injected marker anywhere in the
// serialized error, the serialized cause, or the pretty-printed cause.
// Returns the error so callers can additionally reject foreign identity.
const expectSanitizedStoreError = (
  exit: Exit.Exit<unknown, unknown>,
  forbidden: readonly string[],
) => {
  if (!Exit.isFailure(exit)) {
    throw new Error("expected a failure exit");
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag !== "Some") {
    throw new Error("expected a typed error on the failure cause");
  }
  if (!(failure.value instanceof ProjectMemoryStoreError)) {
    throw new Error(`expected a fixed store error, got ${String(failure.value)}`);
  }
  assert.equal(failure.value.message, "Project memory operation failed.");
  const rendered = [
    JSON.stringify(failure.value),
    JSON.stringify(exit.cause),
    Cause.pretty(exit.cause),
  ].join("\n");
  for (const marker of forbidden) {
    assert.notInclude(rendered, marker);
  }
  return failure.value;
};

// The injected ledger failure matrix, shared by both service methods: one
// typed repository error, one pure defect, and two foreign errors, each
// carrying markers a sanitized result must never render.
interface LedgerFaultCase {
  readonly label: string;
  readonly effect: (receipt: FaultReceipt) => Effect.Effect<unknown, unknown>;
  readonly check?: (error: unknown) => void;
}

const ledgerFaultCases = (
  foreignStore: ProjectMemoryStoreError,
): ReadonlyArray<LedgerFaultCase> => [
  {
    label: "typed persistence error",
    effect: (receipt) =>
      injectedFault(
        receipt,
        Effect.fail(
          new PersistenceSqlError({
            operation: "SECRET-OP",
            detail: "SECRET-DETAIL",
            cause: { body: "SECRET-CAUSE" },
          }),
        ),
      ),
  },
  {
    label: "pure defect",
    effect: (receipt) => injectedFault(receipt, Effect.die(new Error("SECRET-DEFECT"))),
  },
  {
    label: "foreign store error",
    effect: (receipt) => injectedFault(receipt, Effect.fail(foreignStore)),
    check: (error) => assert.notStrictEqual(error, foreignStore),
  },
  {
    label: "foreign rejection",
    effect: (receipt) =>
      injectedFault(
        receipt,
        Effect.fail(new ProjectMemoryRejectedError({ reason: "sensitive", message: "SECRET-REJ" })),
      ),
  },
];

const seedProject = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      )
      VALUES (${projectId}, 'Project', '/tmp/project', '[]', ${NOW}, ${NOW}, NULL)
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
      VALUES (${threadId}, ${projectId}, 'Thread', '{"instanceId":"pi","model":"m"}', 'full-access', 'default', ${NOW}, ${NOW}, NULL)
    `;
  });

const seedMessage = (threadId: string, messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
      )
      VALUES (${messageId}, ${threadId}, NULL, 'user', 'text', 0, ${NOW}, ${NOW})
    `;
  });

const tombstoneProject = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = ${projectId}
    `;
  });

const seedMemory = (input: {
  readonly memoryId: string;
  readonly projectId?: string;
  readonly title?: string;
  readonly body?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO project_memories (
        memory_id, project_id, kind, title, body, version,
        origin_type, origin_thread_id, origin_message_id,
        valid_until, estimated_tokens, created_at, updated_at
      )
      VALUES (
        ${input.memoryId}, ${input.projectId ?? "project-1"}, 'fact',
        ${input.title ?? "Deploy runbook"}, ${input.body ?? "Run migrations then restart the server"},
        1, 'manual', NULL, NULL,
        NULL, 10, ${NOW}, ${NOW}
      )
    `;
  });

// Attempt + item rows seeded with SQL; the affected history itself is only
// ever produced by the real update/delete triggers on project_memories.
const seedExposure = (input: {
  readonly threadId: string;
  readonly messageId: string;
  readonly memoryId: string;
  readonly projectId?: string;
  readonly version?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const inserted = yield* sql<{ readonly attemptSeq: number }>`
      INSERT INTO project_memory_send_attempts (
        thread_id, message_id, project_id, provider_instance_id, owner_instance_id,
        state, committed_at, settled_at
      )
      VALUES (
        ${input.threadId}, ${input.messageId}, ${input.projectId ?? "project-1"}, 'provider', 'test-owner',
        'provider_accepted', ${NOW}, ${NOW}
      )
      RETURNING attempt_seq AS "attemptSeq"
    `;
    const attemptSeq = inserted[0]?.attemptSeq;
    if (attemptSeq === undefined) {
      throw new Error(`seedExposure: no attempt row for ${input.threadId}/${input.messageId}`);
    }
    yield* sql`
      INSERT INTO project_memory_send_items (attempt_seq, memory_id, memory_version)
      VALUES (${attemptSeq}, ${input.memoryId}, ${input.version ?? 1})
    `;
  });

const bumpMemory = (memoryId: string, suffix: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      UPDATE project_memories
      SET title = ${`Runbook ${suffix}`}, version = version + 1
      WHERE memory_id = ${memoryId}
    `;
  });

const ackedThrough = (threadId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly acked: number }>`
      SELECT acked_through_change_seq AS "acked"
      FROM project_memory_thread_acks
      WHERE thread_id = ${threadId}
    `;
    return rows[0]?.acked ?? null;
  });

const expectRejected = (error: unknown, reason: string) => {
  if (!(error instanceof ProjectMemoryRejectedError)) {
    throw new Error(`expected a rejection, got ${String(error)}`);
  }
  assert.equal(error.reason, reason);
  return error;
};

const memoryRowCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly c: number }>`
    SELECT COUNT(*) AS c FROM project_memories
  `;
  return rows[0]?.c ?? -1;
});

const createInput = (
  overrides: Partial<ProjectMemoryCreateInput> = {},
): ProjectMemoryCreateInput => ({
  projectId: ProjectId.make("project-1"),
  kind: "fact",
  title: "Deploy runbook",
  body: "Run migrations then restart the server",
  ...overrides,
});

describe("ProjectMemoryService", () => {
  test("creates, gets, and lists memories inside one project", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;

      const created = yield* service.create(createInput());
      assert.equal(created.memory.version, 1);
      assert.equal(created.memory.kind, "fact");
      assert.deepEqual(created.memory.origin, { type: "manual" });
      assert.isNumber(created.memory.estimatedTokens);

      const loaded = yield* service.get({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
      });
      assert.equal(loaded.memory.body, "Run migrations then restart the server");

      const page = yield* service.list({ projectId: ProjectId.make("project-1") });
      assert.equal(page.items.length, 1);
      // Summaries carry no body.
      assert.isFalse("body" in page.items[0]!);
      assert.isFalse(page.truncated);
    }));

  test("keeps memories isolated between projects", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      const service = yield* ProjectMemoryService;

      yield* service.create(createInput({ title: "Alpha fact" }));
      yield* service.create(
        createInput({ projectId: ProjectId.make("project-2"), title: "Beta fact" }),
      );

      const alpha = yield* service.list({ projectId: ProjectId.make("project-1") });
      assert.equal(alpha.items.length, 1);
      assert.equal(alpha.items[0]?.title, "Alpha fact");

      const results = yield* service.search({
        projectId: ProjectId.make("project-2"),
        query: "Alpha",
      });
      assert.equal(results.items.length, 0);
    }));

  test("rejects writes for missing or tombstoned projects", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* tombstoneProject("project-1");
      const service = yield* ProjectMemoryService;

      const tombstoned = yield* Effect.flip(service.create(createInput()));
      if (tombstoned._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${tombstoned._tag}`);
      }
      assert.equal(tombstoned.reason, "project-missing");

      const missing = yield* Effect.flip(
        service.create(createInput({ projectId: ProjectId.make("project-never") })),
      );
      if (missing._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${missing._tag}`);
      }
      assert.equal(missing.reason, "project-missing");
    }));

  test("verifies message provenance against the same project", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      yield* seedThread("project-1", "thread-1");
      yield* seedMessage("thread-1", "msg-1");
      const service = yield* ProjectMemoryService;

      const valid = yield* service.create(
        createInput({
          origin: {
            type: "message",
            threadId: ThreadId.make("thread-1"),
            messageId: MessageId.make("msg-1"),
          },
        }),
      );
      assert.equal(valid.memory.origin.type, "message");

      const wrongProject = yield* Effect.flip(
        service.create(
          createInput({
            projectId: ProjectId.make("project-2"),
            origin: {
              type: "message",
              threadId: ThreadId.make("thread-1"),
              messageId: MessageId.make("msg-1"),
            },
          }),
        ),
      );
      if (wrongProject._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${wrongProject._tag}`);
      }
      assert.equal(wrongProject.reason, "origin-invalid");

      const ghost = yield* Effect.flip(
        service.create(
          createInput({
            origin: {
              type: "message",
              threadId: ThreadId.make("thread-1"),
              messageId: MessageId.make("msg-missing"),
            },
          }),
        ),
      );
      if (ghost._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${ghost._tag}`);
      }
      assert.equal(ghost.reason, "origin-invalid");
    }));

  test("rejects sensitive-looking text without echoing it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const secretBody = 'api_key = "sk_live_4eC39HqLyjWDarjtT1zdp7dc"';

      const error = yield* Effect.flip(service.create(createInput({ body: secretBody })));
      if (error._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${error._tag}`);
      }
      assert.equal(error.reason, "sensitive");
      assert.isFalse(error.message.includes("sk_live"));

      // The rejection must not partially store the row.
      const rows = yield* memoryRowCount;
      assert.equal(rows, 0);
    }));

  test("enforces strict expectedVersion on update and delete", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const created = yield* service.create(createInput());

      const stale = yield* Effect.flip(
        service.update({
          projectId: created.memory.projectId,
          memoryId: created.memory.memoryId,
          expectedVersion: 9,
          title: "New title",
        }),
      );
      if (stale._tag !== "ProjectMemoryConflictError") {
        throw new Error(`expected conflict, got ${stale._tag}`);
      }
      assert.equal(stale.currentVersion, 1);

      const updated = yield* service.update({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
        expectedVersion: 1,
        title: "New title",
      });
      assert.equal(updated.memory.version, 2);
      assert.equal(updated.memory.title, "New title");
      // Untouched fields survive.
      assert.equal(updated.memory.body, "Run migrations then restart the server");

      const staleDelete = yield* Effect.flip(
        service.delete({
          projectId: created.memory.projectId,
          memoryId: created.memory.memoryId,
          expectedVersion: 1,
        }),
      );
      if (staleDelete._tag !== "ProjectMemoryConflictError") {
        throw new Error(`expected conflict, got ${staleDelete._tag}`);
      }
      assert.equal(staleDelete.currentVersion, 2);
    }));

  test("returns not-found for missing memories on get/update/delete", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;

      const missingId = ProjectMemoryId.make("mem-missing");
      const error = yield* Effect.flip(
        service.get({
          projectId: ProjectId.make("project-1"),
          memoryId: missingId,
        }),
      );
      if (error._tag !== "ProjectMemoryNotFoundError") {
        throw new Error(`expected not-found, got ${error._tag}`);
      }
      assert.equal(error.memoryId, missingId);
    }));

  test("deletes a memory so it disappears from get, list, and search", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const created = yield* service.create(createInput({ title: "ephemeral note" }));

      yield* service.delete({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
        expectedVersion: 1,
      });

      assert.equal(
        (yield* service.list({ projectId: ProjectId.make("project-1") })).items.length,
        0,
      );
      assert.equal(
        (yield* service.search({
          projectId: ProjectId.make("project-1"),
          query: "ephemeral",
        })).items.length,
        0,
      );
      const error = yield* Effect.flip(
        service.get({
          projectId: created.memory.projectId,
          memoryId: created.memory.memoryId,
        }),
      );
      assert.isTrue(error instanceof ProjectMemoryNotFoundError);
    }));

  test("searches Korean 1-2 char terms, mixed text, and literal wildcards", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      yield* service.create(
        createInput({ title: "빌드 설정", body: "dist 폴더는 git에서 제외한다" }),
      );
      yield* service.create(createInput({ title: "Coverage 100% 달성", body: "threshold 유지" }));
      yield* service.create(createInput({ title: 'literal "quotes" task_name', body: "plain" }));

      const shortKorean = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "빌드",
      });
      assert.deepEqual(
        shortKorean.items.map((item) => item.title),
        ["빌드 설정"],
      );

      const singleChar = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "빌 설정",
      });
      assert.equal(singleChar.items.length, 1);

      const percent = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "100%",
      });
      assert.deepEqual(
        percent.items.map((item) => item.title),
        ["Coverage 100% 달성"],
      );

      const underscore = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "task_name",
      });
      assert.equal(underscore.items.length, 1);

      const english = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "threshold",
      });
      assert.equal(english.items.length, 1);
      assert.equal(english.items[0]?.title, "Coverage 100% 달성");
    }));

  test("a whitespace-only query browses like list", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      yield* service.create(createInput());

      const page = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "   ",
      });
      assert.equal(page.items.length, 1);
    }));

  test("keeps expired memories listable and deletable", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;

      const created = yield* service.create(createInput({ validUntil: "2020-01-01T00:00:00Z" }));
      assert.equal(created.memory.validUntil, "2020-01-01T00:00:00.000Z");

      const page = yield* service.list({ projectId: ProjectId.make("project-1") });
      assert.equal(page.items.length, 1);

      yield* service.delete({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
        expectedVersion: 1,
      });
    }));

  test("clears expiry with null and replaces it with a new instant", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;

      const created = yield* service.create(
        createInput({ validUntil: "2030-01-01T00:00:00+09:00" }),
      );
      // Normalized to Z (offset converted).
      assert.equal(created.memory.validUntil, "2029-12-31T15:00:00.000Z");

      const cleared = yield* service.update({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
        expectedVersion: 1,
        validUntil: null,
      });
      assert.isNull(cleared.memory.validUntil);
    }));

  test("rolls back the row when the index write fails", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DROP TABLE project_memory_fts`;
      const error = yield* Effect.flip(service.create(createInput()));
      assert.isTrue(error instanceof ProjectMemoryStoreError);
      assert.equal(yield* memoryRowCount, 0);
    }));

  test("does not serialize memory content from a nested storage failure", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const sql = yield* SqlClient.SqlClient;
      const body = "SYNTHETIC_PRIVATE_MEMORY_FAILURE_MARKER";
      yield* sql`
        CREATE TRIGGER reject_memory_insert BEFORE INSERT ON project_memories
        BEGIN SELECT RAISE(ABORT, NEW.body); END
      `;

      const error = yield* Effect.flip(service.create(createInput({ body })));
      if (error._tag !== "ProjectMemoryStoreError") {
        throw new Error(`Expected store error, got ${error._tag}`);
      }
      const encoded = JSON.stringify(encodeStoreError(error));
      assert.isFalse(encoded.includes(body));
      assert.equal(error.message, "Project memory operation failed.");
      assert.equal(yield* memoryRowCount, 0);
    }));

  test("hides but preserves orphaned rows after a raw project delete", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      yield* service.create(createInput());
      const sql = yield* SqlClient.SqlClient;

      // A projection rebuild raw-deletes the project row — no tombstone.
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'project-1'`;

      // Reads hide the orphan behind the live-project filter.
      const page = yield* service.list({ projectId: ProjectId.make("project-1") });
      assert.equal(page.items.length, 0);
      const error = yield* Effect.flip(service.create(createInput({ title: "another" })));
      if (error._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${error._tag}`);
      }
      assert.equal(error.reason, "project-missing");

      // Rejected writes do not destroy user fact data — the row survives.
      assert.equal(yield* memoryRowCount, 1);
    }));

  test("reports not-found when updating a memory under a dead project", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const created = yield* service.create(createInput());
      const sql = yield* SqlClient.SqlClient;

      // Raw project delete leaves the memory row orphaned; the write's live
      // guard decides inside the statement, so this is not-found — and the
      // orphan is left alone.
      yield* sql`DELETE FROM projection_projects WHERE project_id = 'project-1'`;
      const error = yield* Effect.flip(
        service.update({
          projectId: created.memory.projectId,
          memoryId: created.memory.memoryId,
          expectedVersion: 1,
          title: "Too late",
        }),
      );
      assert.isTrue(error instanceof ProjectMemoryNotFoundError);
      assert.equal(yield* memoryRowCount, 1);
    }));

  test("rejects sensitive text on update without leaking it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const created = yield* service.create(createInput());
      const secretBody = 'token = "ghp_16C7e42F292c6912E7710c838347Ae178B4a"';

      const error = yield* Effect.flip(
        service.update({
          projectId: created.memory.projectId,
          memoryId: created.memory.memoryId,
          expectedVersion: 1,
          body: secretBody,
        }),
      );
      if (error._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${error._tag}`);
      }
      assert.equal(error.reason, "sensitive");
      assert.isFalse(error.message.includes("ghp_"));

      // The stored row keeps its previous body — the rejection never wrote.
      const still = yield* service.get({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
      });
      assert.equal(still.memory.body, "Run migrations then restart the server");
      assert.equal(still.memory.version, 1);
    }));

  test("stores NFC-normalized text so decomposed and composed forms collide", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      // NFD input: jamo decomposed title vs composed query.
      const created = yield* service.create(createInput({ title: "배포 절차", body: "staging" }));
      const searched = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "배포".normalize("NFD"),
      });
      assert.equal(searched.items.length, 1);
      assert.equal(searched.items[0]?.title, created.memory.title.normalize("NFC"));
      const composed = yield* service.search({
        projectId: ProjectId.make("project-1"),
        query: "배포",
      });
      assert.equal(composed.items.length, 1);
    }));

  describe("thread recovery (M2)", () => {
    test("S10 keeps the thread page cap aligned with the ledger page cap", () =>
      Effect.succeed(
        assert.equal(PROJECT_MEMORY_THREAD_CHANGES_MAX, PROJECT_MEMORY_AFFECTED_PAGE_MAX),
      ));

    test("S1 reports an empty state for a live thread with no history", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        const service = yield* ProjectMemoryService;

        const state = yield* service.threadState({
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        });
        assert.deepEqual(state, {
          held: false,
          latestChangeSeq: null,
          acknowledgedThrough: 0,
          changes: [],
          mayHaveMore: false,
        });
      }));

    test("S2 masks deleted rows' ids and never serializes memory text", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        yield* seedMemory({ memoryId: "mem-kept", title: "SECRET-T", body: "SECRET-B" });
        yield* seedMemory({ memoryId: "mem-gone", title: "SECRET-T", body: "SECRET-B" });
        yield* seedExposure({ threadId: "thread-1", messageId: "message-1", memoryId: "mem-kept" });
        yield* seedExposure({ threadId: "thread-1", messageId: "message-2", memoryId: "mem-gone" });
        const service = yield* ProjectMemoryService;

        // Affected rows come only from the real update/delete triggers.
        yield* bumpMemory("mem-kept", "second");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM project_memories WHERE memory_id = 'mem-gone'`;

        const state = yield* service.threadState({
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        });
        assert.equal(state.held, true);
        assert.equal(state.latestChangeSeq, 2);
        assert.equal(state.acknowledgedThrough, 0);
        assert.deepEqual(
          state.changes.map((change) => change.changeSeq),
          [2, 1],
        );
        // The deleted change never carries an id; the updated one resolves
        // because the memory still exists in the requested live project.
        const deleted = state.changes[0]!;
        assert.equal(deleted.reason, "deleted");
        assert.isFalse("memoryId" in deleted);
        const updated = state.changes[1]!;
        assert.equal(updated.reason, "updated");
        assert.equal(updated.memoryId, ProjectMemoryId.make("mem-kept"));

        const serialized = JSON.stringify(state);
        assert.notInclude(serialized, "SECRET-T");
        assert.notInclude(serialized, "SECRET-B");
      }));

    test("S3 acknowledging a shown watermark keeps later changes held, retries are unchanged", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        yield* seedMemory({ memoryId: "mem-1" });
        yield* seedExposure({ threadId: "thread-1", messageId: "message-1", memoryId: "mem-1" });
        yield* bumpMemory("mem-1", "one");
        const service = yield* ProjectMemoryService;
        const projectId = ProjectId.make("project-1");
        const threadId = ThreadId.make("thread-1");

        const before = yield* service.threadState({ projectId, threadId });
        assert.equal(before.latestChangeSeq, 1);

        // A real change lands after the client looked at the state.
        yield* bumpMemory("mem-1", "two");
        const acked = yield* service.acknowledgeThread({
          projectId,
          threadId,
          throughChangeSeq: 1,
        });
        assert.deepEqual(acked, { status: "applied", acknowledgedThrough: 1 });

        // The separate state read shows only the later change.
        const after = yield* service.threadState({ projectId, threadId });
        assert.equal(after.held, true);
        assert.equal(after.acknowledgedThrough, 1);
        assert.deepEqual(
          after.changes.map((change) => change.changeSeq),
          [2],
        );

        // The same watermark retries as unchanged while the scope stays valid;
        // the next watermark clears the hold.
        const retry = yield* service.acknowledgeThread({
          projectId,
          threadId,
          throughChangeSeq: 1,
        });
        assert.deepEqual(retry, { status: "unchanged", acknowledgedThrough: 1 });
        const cleared = yield* service.acknowledgeThread({
          projectId,
          threadId,
          throughChangeSeq: 2,
        });
        assert.deepEqual(cleared, { status: "applied", acknowledgedThrough: 2 });
        const final = yield* service.threadState({ projectId, threadId });
        assert.equal(final.held, false);
        assert.deepEqual(final.changes, []);
      }));

    test("S4 rejects watermarks beyond the recorded history without writing an ack", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        const service = yield* ProjectMemoryService;
        const projectId = ProjectId.make("project-1");
        const threadId = ThreadId.make("thread-1");

        // No history at all: every positive watermark is beyond the latest.
        expectRejected(
          yield* Effect.flip(
            service.acknowledgeThread({ projectId, threadId, throughChangeSeq: 1 }),
          ),
          "acknowledgement-invalid",
        );
        assert.isNull(yield* ackedThrough("thread-1"));

        yield* seedMemory({ memoryId: "mem-1" });
        yield* seedExposure({ threadId: "thread-1", messageId: "message-1", memoryId: "mem-1" });
        yield* bumpMemory("mem-1", "one");

        expectRejected(
          yield* Effect.flip(
            service.acknowledgeThread({ projectId, threadId, throughChangeSeq: 2 }),
          ),
          "acknowledgement-invalid",
        );
        assert.isNull(yield* ackedThrough("thread-1"));
      }));

    test("S5 state and ack reject foreign, missing, and tombstoned scopes", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedProject("project-2");
        yield* seedThread("project-1", "thread-1");
        yield* seedThread("project-1", "thread-tombstoned");
        yield* seedMemory({ memoryId: "mem-1" });
        yield* seedExposure({ threadId: "thread-1", messageId: "message-1", memoryId: "mem-1" });
        yield* bumpMemory("mem-1", "one");
        const service = yield* ProjectMemoryService;
        const sql = yield* SqlClient.SqlClient;

        expectRejected(
          yield* Effect.flip(
            service.threadState({
              projectId: ProjectId.make("project-2"),
              threadId: ThreadId.make("thread-1"),
            }),
          ),
          "thread-missing",
        );
        expectRejected(
          yield* Effect.flip(
            service.threadState({
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-missing"),
            }),
          ),
          "thread-missing",
        );

        yield* sql`UPDATE projection_threads SET deleted_at = ${NOW} WHERE thread_id = 'thread-tombstoned'`;
        expectRejected(
          yield* Effect.flip(
            service.threadState({
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-tombstoned"),
            }),
          ),
          "thread-missing",
        );

        // A live thread row under a tombstoned project is also out of scope.
        yield* sql`UPDATE projection_projects SET deleted_at = ${NOW} WHERE project_id = 'project-1'`;
        expectRejected(
          yield* Effect.flip(
            service.threadState({
              projectId: ProjectId.make("project-1"),
              threadId: ThreadId.make("thread-1"),
            }),
          ),
          "thread-missing",
        );

        // The acknowledge path enforces the same scope and writes nothing.
        expectRejected(
          yield* Effect.flip(
            service.acknowledgeThread({
              projectId: ProjectId.make("project-2"),
              threadId: ThreadId.make("thread-1"),
              throughChangeSeq: 1,
            }),
          ),
          "thread-missing",
        );
        assert.isNull(yield* ackedThrough("thread-1"));
      }));

    test("S5 a reused thread id keeps its history but masks ids outside the new project", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-a");
        yield* seedProject("project-b");
        yield* seedThread("project-a", "thread-x");
        yield* seedMemory({
          memoryId: "mem-a",
          projectId: "project-a",
          title: "SECRET-T",
          body: "SECRET-B",
        });
        yield* seedExposure({
          threadId: "thread-x",
          messageId: "message-1",
          memoryId: "mem-a",
          projectId: "project-a",
        });
        yield* bumpMemory("mem-a", "moved");
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          UPDATE projection_threads
          SET project_id = 'project-b', deleted_at = NULL
          WHERE thread_id = 'thread-x'
        `;
        const service = yield* ProjectMemoryService;

        const reused = yield* service.threadState({
          projectId: ProjectId.make("project-b"),
          threadId: ThreadId.make("thread-x"),
        });
        assert.equal(reused.held, true);
        assert.equal(reused.latestChangeSeq, 1);
        assert.equal(reused.changes.length, 1);
        // The ledger keeps the thread id's whole lifetime, but mem-a does not
        // live in the requested project, so the id is masked everywhere.
        assert.isFalse("memoryId" in reused.changes[0]!);
        const serialized = JSON.stringify(reused);
        assert.notInclude(serialized, "mem-a");
        assert.notInclude(serialized, "SECRET-T");
        assert.notInclude(serialized, "SECRET-B");

        expectRejected(
          yield* Effect.flip(
            service.threadState({
              projectId: ProjectId.make("project-a"),
              threadId: ThreadId.make("thread-x"),
            }),
          ),
          "thread-missing",
        );
        expectRejected(
          yield* Effect.flip(
            service.acknowledgeThread({
              projectId: ProjectId.make("project-a"),
              threadId: ThreadId.make("thread-x"),
              throughChangeSeq: 1,
            }),
          ),
          "thread-missing",
        );
        assert.isNull(yield* ackedThrough("thread-x"));
      }));

    test("S8 one ack covers the whole watermark, including omitted pages", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        yield* seedMemory({ memoryId: "mem-1" });
        yield* seedExposure({ threadId: "thread-1", messageId: "message-1", memoryId: "mem-1" });
        for (let i = 0; i < 60; i += 1) {
          yield* bumpMemory("mem-1", `p${i}`);
        }
        const service = yield* ProjectMemoryService;
        const projectId = ProjectId.make("project-1");
        const threadId = ThreadId.make("thread-1");

        const page = yield* service.threadState({ projectId, threadId, limit: 5 });
        assert.equal(page.held, true);
        assert.equal(page.latestChangeSeq, 60);
        assert.equal(page.acknowledgedThrough, 0);
        assert.deepEqual(
          page.changes.map((change) => change.changeSeq),
          [60, 59, 58, 57, 56],
        );
        assert.equal(page.mayHaveMore, true);

        // Acknowledging the latest covers the 55 unshown changes too.
        const acked = yield* service.acknowledgeThread({
          projectId,
          threadId,
          throughChangeSeq: 60,
        });
        assert.deepEqual(acked, { status: "applied", acknowledgedThrough: 60 });

        const cleared = yield* service.threadState({ projectId, threadId, limit: 5 });
        assert.equal(cleared.held, false);
        assert.deepEqual(cleared.changes, []);
        assert.equal(cleared.mayHaveMore, false);
        assert.equal(cleared.acknowledgedThrough, 60);

        yield* bumpMemory("mem-1", "after");
        const again = yield* service.threadState({ projectId, threadId, limit: 5 });
        assert.equal(again.held, true);
        assert.deepEqual(
          again.changes.map((change) => change.changeSeq),
          [61],
        );
        assert.equal(again.mayHaveMore, false);
      }));

    test("S6 a read parked mid-transaction stays coherent when the thread is reassigned", (hooks, dbPath) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-a");
        yield* seedProject("project-b");
        yield* seedThread("project-a", "thread-x");
        yield* seedMemory({ memoryId: "mem-a", projectId: "project-a" });
        yield* seedExposure({
          threadId: "thread-x",
          messageId: "message-1",
          memoryId: "mem-a",
          projectId: "project-a",
        });
        yield* bumpMemory("mem-a", "one");
        const service = yield* ProjectMemoryService;

        const parked = yield* Deferred.make<Option.Option<ProjectionThread>>();
        const gate = yield* Deferred.make<void>();
        hooks.threadReadGate = { parked, gate };
        const fiber = yield* Effect.forkChild(
          service.threadState({
            projectId: ProjectId.make("project-a"),
            threadId: ThreadId.make("thread-x"),
          }),
        );

        // From the parked wait through the join, a failing assertion must
        // still release the gate, or the parked child fiber would hang the
        // test. The deferred only succeeds once, so the release below is the
        // no-op when the normal path already opened it.
        const exit = yield* Effect.gen(function* () {
          // The gate carries the REAL read result: the thread row was
          // actually loaded from project-a before anything else happens.
          const receipt = yield* Deferred.await(parked);
          if (!Option.isSome(receipt)) {
            return assert.fail("expected the real thread read to complete before parking");
          }
          assert.equal(receipt.value.projectId, "project-a");
          assert.isNull(receipt.value.deletedAt);

          // A second, independent client commits reassignment and delete in
          // ONE transaction while the first connection holds its WAL read
          // snapshot. The real delete trigger records change seq 2, so a
          // non-transactional first read would observe a mixed A/B state.
          yield* runWithClient(
            dbPath,
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              yield* sql.withTransaction(
                Effect.gen(function* () {
                  yield* sql`UPDATE projection_threads SET project_id = 'project-b' WHERE thread_id = 'thread-x'`;
                  yield* sql`DELETE FROM project_memories WHERE memory_id = 'mem-a'`;
                }),
              );
            }),
          );
          yield* Deferred.succeed(gate, undefined);
          return yield* Fiber.await(fiber);
        }).pipe(Effect.ensuring(Deferred.succeed(gate, undefined)));
        if (Exit.isSuccess(exit)) {
          // The parked read returns the complete pre-commit project-a
          // snapshot: seq 2 (the delete) is invisible to it and mem-a still
          // resolves inside it — never a mixed A/B answer.
          assert.equal(exit.value.held, true);
          assert.deepEqual(exit.value, {
            held: true,
            latestChangeSeq: 1,
            acknowledgedThrough: 0,
            changes: [
              {
                changeSeq: 1,
                reason: "updated",
                memoryId: ProjectMemoryId.make("mem-a"),
              },
            ],
            mayHaveMore: false,
          });
          for (const change of exit.value.changes) {
            assert.isDefined(change.memoryId);
          }
        } else {
          const failure = Cause.findErrorOption(exit.cause);
          if (failure._tag !== "Some") {
            return assert.fail("expected a typed outcome, got a pure defect or interrupt");
          }
          expectRejected(failure.value, "thread-missing");
        }

        // Either way, the next read sees the committed reassignment.
        expectRejected(
          yield* Effect.flip(
            service.threadState({
              projectId: ProjectId.make("project-a"),
              threadId: ThreadId.make("thread-x"),
            }),
          ),
          "thread-missing",
        );

        // And the new scope reads the committed state: both changes, the
        // delete included, with every memory id masked because mem-a is gone.
        const fromB = yield* service.threadState({
          projectId: ProjectId.make("project-b"),
          threadId: ThreadId.make("thread-x"),
        });
        assert.equal(fromB.held, true);
        assert.equal(fromB.latestChangeSeq, 2);
        assert.deepEqual(
          fromB.changes.map((change) => change.changeSeq),
          [2, 1],
        );
        for (const change of fromB.changes) {
          assert.isFalse("memoryId" in change);
        }
        assert.equal(fromB.mayHaveMore, false);
      }));

    test("S7 an ack after reassignment is scope-rejected; the new scope applies", (_hooks, dbPath) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-a");
        yield* seedProject("project-b");
        yield* seedThread("project-a", "thread-x");
        yield* seedMemory({ memoryId: "mem-a", projectId: "project-a" });
        yield* seedExposure({
          threadId: "thread-x",
          messageId: "message-1",
          memoryId: "mem-a",
          projectId: "project-a",
        });
        yield* bumpMemory("mem-a", "one");
        const service = yield* ProjectMemoryService;

        // The reassignment commits first — the settled outcome, not an
        // in-flight race.
        yield* runWithClient(
          dbPath,
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            yield* sql`UPDATE projection_threads SET project_id = 'project-b' WHERE thread_id = 'thread-x'`;
          }),
        );

        expectRejected(
          yield* Effect.flip(
            service.acknowledgeThread({
              projectId: ProjectId.make("project-a"),
              threadId: ThreadId.make("thread-x"),
              throughChangeSeq: 1,
            }),
          ),
          "thread-missing",
        );
        assert.isNull(yield* ackedThrough("thread-x"));

        // The same watermark under the now-valid scope is applied.
        const applied = yield* service.acknowledgeThread({
          projectId: ProjectId.make("project-b"),
          threadId: ThreadId.make("thread-x"),
          throughChangeSeq: 1,
        });
        assert.deepEqual(applied, { status: "applied", acknowledgedThrough: 1 });
        assert.equal(yield* ackedThrough("thread-x"), 1);
      }));

    test("S9 threadState sanitizes injected ledger failures into a fixed store error", (hooks) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        const service = yield* ProjectMemoryService;
        const input = {
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        };
        const foreignStore = new ProjectMemoryStoreError({ message: "SECRET-STORE" });

        for (const faultCase of ledgerFaultCases(foreignStore)) {
          const receipt: FaultReceipt = { count: 0 };
          hooks.ledgerFault = { method: "affectedState", effect: faultCase.effect(receipt) };
          const exit = yield* Effect.exit(service.threadState(input));
          assert.equal(
            receipt.count,
            1,
            `the injected ${faultCase.label} effect did not execute exactly once`,
          );
          const error = expectSanitizedStoreError(exit, INJECTED_SECRETS);
          faultCase.check?.(error);
        }
      }));

    test("S9 acknowledgeThread sanitizes injected ledger failures and writes no ack", (hooks) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        const service = yield* ProjectMemoryService;
        const input = {
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
          throughChangeSeq: 3,
        };
        const foreignStore = new ProjectMemoryStoreError({ message: "SECRET-STORE" });

        for (const faultCase of ledgerFaultCases(foreignStore)) {
          const receipt: FaultReceipt = { count: 0 };
          hooks.ledgerFault = { method: "acknowledge", effect: faultCase.effect(receipt) };
          const exit = yield* Effect.exit(service.acknowledgeThread(input));
          assert.equal(
            receipt.count,
            1,
            `the injected ${faultCase.label} effect did not execute exactly once`,
          );
          const error = expectSanitizedStoreError(exit, INJECTED_SECRETS);
          faultCase.check?.(error);
          // A failed ack never writes the watermark.
          assert.isNull(yield* ackedThrough("thread-1"));
        }
      }));

    test("S9' a cause mixed with an interrupt propagates as a fresh pure interrupt", (hooks) =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        const service = yield* ProjectMemoryService;
        const input = {
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        };
        const expectPureInterrupt = (exit: Exit.Exit<unknown, unknown>) => {
          if (!Exit.isFailure(exit)) {
            throw new Error("expected the mixed cause to fail");
          }
          // A fresh pure interrupt: the mixed foreign cause is not rethrown,
          // carries no typed or defect payload, and leaks no secrets.
          assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
          assert.isTrue(Option.isNone(Cause.findErrorOption(exit.cause)));
          const rendered = JSON.stringify(exit.cause) + Cause.pretty(exit.cause);
          for (const secret of INJECTED_SECRETS) {
            assert.notInclude(rendered, secret);
          }
        };

        const stateReceipt: FaultReceipt = { count: 0 };
        hooks.ledgerFault = {
          method: "affectedState",
          effect: injectedFault(
            stateReceipt,
            Effect.failCause(
              Cause.combine(
                Cause.fail(
                  new PersistenceSqlError({
                    operation: "SECRET-OP",
                    detail: "SECRET-DETAIL",
                    cause: { body: "SECRET-CAUSE" },
                  }),
                ),
                Cause.interrupt(),
              ),
            ),
          ),
        };
        const stateExit = yield* Effect.exit(service.threadState(input));
        assert.equal(
          stateReceipt.count,
          1,
          "the injected mixed-cause effect did not execute exactly once",
        );
        expectPureInterrupt(stateExit);

        const ackReceipt: FaultReceipt = { count: 0 };
        hooks.ledgerFault = {
          method: "acknowledge",
          effect: injectedFault(
            ackReceipt,
            Effect.failCause(
              Cause.combine(
                Cause.fail(new ProjectMemoryStoreError({ message: "SECRET-STORE" })),
                Cause.interrupt(),
              ),
            ),
          ),
        };
        const ackExit = yield* Effect.exit(
          service.acknowledgeThread({ ...input, throughChangeSeq: 1 }),
        );
        assert.equal(
          ackReceipt.count,
          1,
          "the injected mixed-cause effect did not execute exactly once",
        );
        expectPureInterrupt(ackExit);
        assert.isNull(yield* ackedThrough("thread-1"));
      }));

    test("S9 a renamed affected table surfaces as the fixed store error, not SQL detail", () =>
      Effect.gen(function* () {
        yield* runMigrations();
        yield* seedProject("project-1");
        yield* seedThread("project-1", "thread-1");
        yield* seedMemory({ memoryId: "mem-1" });
        yield* seedExposure({ threadId: "thread-1", messageId: "message-1", memoryId: "mem-1" });
        yield* bumpMemory("mem-1", "one");
        const service = yield* ProjectMemoryService;
        const input = {
          projectId: ProjectId.make("project-1"),
          threadId: ThreadId.make("thread-1"),
        };
        const sql = yield* SqlClient.SqlClient;

        // Valid live scope first: both real paths succeed before the fault,
        // so the later failures can only come from the rename.
        const before = yield* service.threadState(input);
        assert.equal(before.held, true);
        assert.equal(before.latestChangeSeq, 1);
        assert.deepEqual(yield* service.acknowledgeThread({ ...input, throughChangeSeq: 1 }), {
          status: "applied",
          acknowledgedThrough: 1,
        });

        yield* sql`ALTER TABLE project_memory_affected RENAME TO project_memory_affected_gone`;

        const sqlMarkers = [
          "project_memory_affected",
          "project_memory_affected_gone",
          "ALTER",
          "SELECT",
        ];
        const stateExit = yield* Effect.exit(service.threadState(input));
        expectSanitizedStoreError(stateExit, sqlMarkers);
        const ackExit = yield* Effect.exit(
          service.acknowledgeThread({ ...input, throughChangeSeq: 2 }),
        );
        expectSanitizedStoreError(ackExit, sqlMarkers);
        // The failed acks never moved the watermark the normal call wrote.
        assert.equal(yield* ackedThrough("thread-1"), 1);
      }));
  });

  test("update and delete run inside the shared ledger mutation fence; create does not", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const ledger = yield* ProjectMemorySendLedger;

      // A fresh id can never belong to an existing attempt — create stays
      // outside the fence by design.
      const beforeCreate = ledger.captureMutationFence();
      const created = yield* service.create(createInput());
      assert.isTrue(ledger.mutationFenceHolds(beforeCreate));

      const beforeUpdate = ledger.captureMutationFence();
      yield* service.update({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
        expectedVersion: 1,
        title: "New title",
      });
      assert.isFalse(ledger.mutationFenceHolds(beforeUpdate));

      const beforeDelete = ledger.captureMutationFence();
      yield* service.delete({
        projectId: created.memory.projectId,
        memoryId: created.memory.memoryId,
        expectedVersion: 2,
      });
      assert.isFalse(ledger.mutationFenceHolds(beforeDelete));

      // A stale-version update is rejected before the repository write, so
      // the fence is never acquired — only real mutations break it.
      yield* seedMemory({ memoryId: "mem-conflict" });
      const beforeConflict = ledger.captureMutationFence();
      const conflict = yield* Effect.flip(
        service.update({
          projectId: ProjectId.make("project-1"),
          memoryId: ProjectMemoryId.make("mem-conflict"),
          expectedVersion: 9,
          title: "x",
        }),
      );
      assert.equal(conflict._tag, "ProjectMemoryConflictError");
      assert.isTrue(ledger.mutationFenceHolds(beforeConflict));

      assert.isTrue(ledger.mutationFenceHolds(ledger.captureMutationFence()));
    }));
});

describe("ProjectMemoryService agent proposals", () => {
  const PROJECT = ProjectId.make("project-1");
  const THREAD = ThreadId.make("thread-1");
  const proposal = (overrides: { text?: string; reason?: string } = {}) => ({
    projectId: PROJECT,
    threadId: THREAD,
    text: "Use pnpm, not npm, in this repo.\nThe lockfile is pnpm-lock.yaml.",
    reason: "The user corrected me twice.",
    ...overrides,
  });

  test("a pending proposal is invisible to list, search, get, and the memory table", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;

      const pending = yield* service.propose(proposal());
      assert.equal(pending.title, "Use pnpm, not npm, in this repo.");

      assert.deepEqual((yield* service.list({ projectId: PROJECT })).items, []);
      assert.deepEqual(
        (yield* service.search({ projectId: PROJECT, query: "lockfile" })).items,
        [],
      );
      assert.equal(yield* memoryRowCount, 0);
      const listed = (yield* service.listProposals({ projectId: PROJECT })).items;
      assert.deepEqual(
        listed.map((item) => [item.proposalId, item.reason]),
        [[pending.proposalId, "The user corrected me twice."]],
      );
      // Another project never sees it.
      assert.deepEqual(
        (yield* service.listProposals({ projectId: ProjectId.make("project-2") })).items,
        [],
      );
    }));

  test("approving moves the proposal into searchable memory exactly once", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const pending = yield* service.propose(proposal());

      const approved = yield* service.approveProposal({
        projectId: PROJECT,
        proposalId: pending.proposalId,
      });
      assert.equal(approved.memory.kind, "fact");
      assert.equal(approved.memory.title, pending.title);
      assert.equal(approved.memory.body, pending.body);
      assert.deepEqual(approved.memory.origin, { type: "manual" });

      assert.deepEqual((yield* service.listProposals({ projectId: PROJECT })).items, []);
      assert.deepEqual(
        (yield* service.search({ projectId: PROJECT, query: "lockfile" })).items.map(
          (item) => item.memoryId,
        ),
        [approved.memory.memoryId],
      );

      const again = yield* Effect.flip(
        service.approveProposal({ projectId: PROJECT, proposalId: pending.proposalId }),
      );
      assert.equal(again._tag, "ProjectMemoryRejectedError");
      assert.equal(yield* memoryRowCount, 1);
    }));

  test("rejecting deletes the proposal and creates no memory", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const pending = yield* service.propose(proposal());

      yield* service.rejectProposal({ projectId: PROJECT, proposalId: pending.proposalId });
      assert.deepEqual((yield* service.listProposals({ projectId: PROJECT })).items, []);
      assert.equal(yield* memoryRowCount, 0);

      const missing = yield* Effect.flip(
        service.rejectProposal({ projectId: PROJECT, proposalId: pending.proposalId }),
      );
      assert.equal(missing._tag, "ProjectMemoryRejectedError");
      const approveMissing = yield* Effect.flip(
        service.approveProposal({ projectId: PROJECT, proposalId: pending.proposalId }),
      );
      assert.equal(approveMissing._tag, "ProjectMemoryRejectedError");
    }));

  test("a proposal can only be decided inside its own project", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      const service = yield* ProjectMemoryService;
      const pending = yield* service.propose(proposal());
      const other = { projectId: ProjectId.make("project-2"), proposalId: pending.proposalId };

      yield* Effect.flip(service.approveProposal(other));
      yield* Effect.flip(service.rejectProposal(other));
      assert.equal((yield* service.listProposals({ projectId: PROJECT })).items.length, 1);
      assert.equal(yield* memoryRowCount, 0);
    }));

  test("rejects sensitive text and reasons without storing or echoing them", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const secret = ["sk", "live", "4eC39HqLyjWDarjtT1zdp7dc"].join("_");
      const assignment = ["api_key", `"${secret}"`].join(" = ");

      for (const attempt of [
        proposal({ text: `Deploy with ${assignment}` }),
        proposal({ reason: `I saw ${assignment}` }),
      ]) {
        const error = yield* Effect.flip(service.propose(attempt));
        if (error._tag !== "ProjectMemoryRejectedError") {
          throw new Error(`expected rejection, got ${error._tag}`);
        }
        assert.equal(error.reason, "sensitive");
        assert.isFalse(error.message.includes("sk_"));
      }
      assert.deepEqual((yield* service.listProposals({ projectId: PROJECT })).items, []);
    }));

  test("rejects empty, oversized, and orphaned proposals", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      const reasonOf = (input: Parameters<typeof service.propose>[0]) =>
        Effect.map(Effect.flip(service.propose(input)), (error) =>
          error._tag === "ProjectMemoryRejectedError" ? error.reason : error._tag,
        );

      assert.equal(yield* reasonOf(proposal({ text: "  " })), "empty");
      assert.equal(yield* reasonOf(proposal({ reason: "" })), "empty");
      assert.equal(yield* reasonOf(proposal({ text: "x".repeat(8001) })), "too-long");
      assert.equal(yield* reasonOf(proposal({ reason: "x".repeat(501) })), "too-long");
      assert.equal(
        yield* reasonOf({ ...proposal(), projectId: ProjectId.make("missing") }),
        "project-missing",
      );
    }));

  test("caps pending proposals per project so a looping agent cannot flood review", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      yield* seedProject("project-2");
      const service = yield* ProjectMemoryService;

      for (let index = 0; index < PROJECT_MEMORY_PENDING_PROPOSALS_MAX; index += 1) {
        yield* service.propose(proposal({ text: `Fact number ${index}` }));
      }
      const overflow = yield* Effect.flip(service.propose(proposal({ text: "One too many" })));
      if (overflow._tag !== "ProjectMemoryRejectedError") {
        throw new Error(`expected rejection, got ${overflow._tag}`);
      }
      assert.equal(overflow.reason, "proposal-limit");

      // Another project has its own budget, and deciding one frees a slot.
      yield* service.propose({ ...proposal(), projectId: ProjectId.make("project-2") });
      const [first] = (yield* service.listProposals({ projectId: PROJECT })).items;
      yield* service.rejectProposal({ projectId: PROJECT, proposalId: first!.proposalId });
      yield* service.propose(proposal({ text: "Now there is room" }));
    }));

  test("a tombstoned project takes its pending proposals with it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* seedProject("project-1");
      const service = yield* ProjectMemoryService;
      yield* service.propose(proposal());

      yield* tombstoneProject("project-1");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly c: number }>`
        SELECT COUNT(*) AS c FROM project_memory_proposals
      `;
      assert.equal(rows[0]?.c, 0);
    }));
});
