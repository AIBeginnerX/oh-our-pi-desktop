// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type AgentSessionImportSource,
} from "@t3tools/contracts";
import { assert, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError";

import { MEMORY_ECHO_WITHHELD_ERROR } from "../../orchestration/memoryEcho.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { PRIOR_PROVIDER_SESSION_IDS_KEY, type ProviderSessionRef } from "../providerSessionIds.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionWriteFence,
} from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";

const importedSource = {
  provider: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerSessionId: "provider-session",
  filePath: "/tmp/provider-session.jsonl",
  size: 100,
  mtimeMs: 1_000,
  device: 1,
  inode: 123,
  birthtimeMs: 500,
} satisfies AgentSessionImportSource;

const claudeSessionA = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
const claudeSessionB = "482fcf9e-1c65-4d21-9a5b-6f0c2b7f4d12";
const claudeSessionC = "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d";
const codexNativeThread = "codex-native-thread-1";

const claudeRef = (
  sessionId: string,
  providerInstanceId = "claude-current",
): ProviderSessionRef => ({
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make(providerInstanceId),
  sessionId,
});

const claudeIdentity = (threadId: ThreadId) =>
  ({
    threadId,
    provider: ProviderDriverKind.make("claudeAgent"),
    providerInstanceId: ProviderInstanceId.make("claude-current"),
  }) as const;

const claudeCursor = (threadId: ThreadId, sessionId: string) => ({
  threadId,
  resume: sessionId,
  turnCount: 0,
});

type RuntimeRepository = ProviderSessionRuntime.ProviderSessionRuntimeRepository["Service"];

function makeDirectoryLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(Layer.provide(persistenceLayer));
  // The directory injects SqlClient itself now: merging persistence beside
  // it only exports the service, so the same layer value is provided
  // explicitly alongside the repository. One build — one client.
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(Layer.mergeAll(runtimeRepositoryLayer, persistenceLayer)),
  );
  return Layer.mergeAll(
    persistenceLayer,
    runtimeRepositoryLayer,
    directoryLayer,
    NodeServices.layer,
  );
}

// The real in-memory SQLite stack with the repository wrapped by `probe`, so
// tests can hold a writer at a Deferred barrier mid-write and observe when a
// queued writer actually reaches the repository. Provide it with
// `{ local: true }`: the shared memo map would otherwise satisfy these
// services from the outer it.layer instance and the probes would never see
// a write.
function makeProbedDirectoryLayer(probe: (real: RuntimeRepository) => Partial<RuntimeRepository>) {
  const baseRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
  const probedRepository = Layer.effect(
    ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    Effect.map(
      ProviderSessionRuntime.ProviderSessionRuntimeRepository,
      (real): RuntimeRepository => ({ ...real, ...probe(real) }),
    ),
  ).pipe(Layer.provide(baseRepository));
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(Layer.mergeAll(probedRepository, SqlitePersistenceMemory)),
  );
  return Layer.mergeAll(
    SqlitePersistenceMemory,
    probedRepository,
    directoryLayer,
    NodeServices.layer,
  );
}

// The first getByThreadId belongs to the writer holding the lock and runs
// free; every later read completes `readerEntered`, so a queued writer
// provably never reached the repository while `readerEntered` is undone.
// Repository upsert call `gateUpsertCall` completes `upsertEntered`, then
// parks on `releaseUpsert` while still holding the thread lock. Callers
// release it via `Effect.ensuring` so a failing body cannot strand the
// uninterruptible writer when the child scope interrupts it at teardown.
function writeProbes(options: {
  readonly upsertEntered: Deferred.Deferred<void>;
  readonly releaseUpsert: Deferred.Deferred<void>;
  readonly readerEntered?: Deferred.Deferred<void>;
  readonly gateUpsertCall?: number;
}) {
  let getCalls = 0;
  let upsertCalls = 0;
  const gateUpsertCall = options.gateUpsertCall ?? 1;
  const readerEntered = options.readerEntered;
  return (real: RuntimeRepository): Partial<RuntimeRepository> => ({
    getByThreadId: (input) =>
      Effect.suspend(() => {
        getCalls++;
        return readerEntered !== undefined && getCalls > 1
          ? Deferred.succeed(readerEntered, undefined).pipe(
              Effect.andThen(real.getByThreadId(input)),
            )
          : real.getByThreadId(input);
      }),
    upsert: (runtime, upsertOptions) =>
      Effect.suspend(() => {
        upsertCalls++;
        return upsertCalls === gateUpsertCall
          ? Deferred.succeed(options.upsertEntered, undefined).pipe(
              Effect.andThen(Deferred.await(options.releaseUpsert)),
              Effect.andThen(real.upsert(runtime, upsertOptions)),
            )
          : real.upsert(runtime, upsertOptions);
      }),
  });
}

const MEMORY_ECHO_NOW = "2026-10-11T09:00:00.000Z";

const insertMemorySendAttempt = (sql: SqlClient.SqlClient, threadId: ThreadId, messageId: string) =>
  sql`INSERT INTO project_memory_send_attempts (
    thread_id, message_id, project_id, provider_instance_id, owner_instance_id, state, committed_at, settled_at
  ) VALUES (${threadId}, ${messageId}, 'project-echo', 'codex', 'owner-echo', 'dispatch_committed', ${MEMORY_ECHO_NOW}, NULL)`;

// Seeds a row straight through the repository — the way a pre-taint write
// left it — so the stored lastError stays raw until a directory write runs.
const seedRuntimeRow = (
  repository: RuntimeRepository,
  threadId: ThreadId,
  runtimePayload: unknown,
) =>
  repository.upsert({
    threadId,
    providerName: "codex",
    providerInstanceId: ProviderInstanceId.make("codex"),
    adapterKey: "codex",
    runtimeMode: "full-access",
    status: "running",
    lastSeenAt: "2026-08-24T10:00:00.000Z",
    resumeCursor: { threadId: "provider-seed-cursor" },
    runtimePayload,
  });

interface MemoryEchoLookupProbe {
  lookups: number;
  armedCause: Cause.Cause<SqlError> | null;
}

// A SqlClient wrapper that counts the memory-echo taint lookup and can arm a
// deterministic cause on it. Only the tagged-template apply is intercepted;
// default property forwarding keeps sql.transactionService and every other
// property identity intact. Every other statement passes straight through
// to the real client.
function makeLookupProbedDirectoryLayer(probe: MemoryEchoLookupProbe) {
  const probedSql = Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const real = yield* SqlClient.SqlClient;
      return new Proxy(real, {
        apply: (target, thisArg, args) => {
          const template = Array.isArray(args[0]) ? (args[0] as readonly string[]).join("") : "";
          if (template.includes("project_memory_send_attempts")) {
            probe.lookups += 1;
            if (probe.armedCause !== null) {
              return Effect.failCause(probe.armedCause);
            }
          }
          return Reflect.apply(target, thisArg, args);
        },
      });
    }),
  ).pipe(Layer.provide(SqlitePersistenceMemory));
  const repositoryLayer = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
  const directoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(Layer.mergeAll(repositoryLayer, probedSql)),
  );
  return Layer.mergeAll(
    SqlitePersistenceMemory,
    repositoryLayer,
    directoryLayer,
    NodeServices.layer,
  );
}

const echoBinding = (threadId: ThreadId) =>
  ({
    threadId,
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
  }) as const;

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))("ProviderSessionDirectoryLive", (it) => {
  it.effect("upserts and reads thread bindings", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const initialThreadId = ThreadId.make("thread-1");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId: initialThreadId,
      });

      const provider = yield* directory.getProvider(initialThreadId);
      assert.equal(provider, "codex");
      const resolvedBinding = yield* directory.getBinding(initialThreadId);
      expect(Option.getOrThrow(resolvedBinding)).toMatchObject({
        threadId: initialThreadId,
        provider: ProviderDriverKind.make("codex"),
      });
      if (Option.isSome(resolvedBinding)) {
        assert.equal(resolvedBinding.value.threadId, initialThreadId);
      }

      const nextThreadId = ThreadId.make("thread-2");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId: nextThreadId,
      });
      const updatedBinding = yield* directory.getBinding(nextThreadId);
      assert.equal(Option.isSome(updatedBinding), true);
      if (Option.isSome(updatedBinding)) {
        assert.equal(updatedBinding.value.threadId, nextThreadId);
      }

      const runtime = yield* runtimeRepository.getByThreadId({ threadId: nextThreadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, nextThreadId);
        assert.equal(runtime.value.status, "running");
        assert.equal(runtime.value.providerName, "codex");
      }

      const threadIds = yield* directory.listThreadIds();
      expect(threadIds).toEqual(expect.arrayContaining([initialThreadId, nextThreadId]));
    }),
  );

  it.effect("persists runtime fields and merges payload updates", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const threadId = ThreadId.make("thread-runtime");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        status: "starting",
        resumeCursor: {
          threadId: "provider-thread-runtime",
        },
        runtimePayload: {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
        },
      });

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        status: "running",
        runtimePayload: {
          activeTurnId: "turn-1",
        },
      });

      const runtime = yield* runtimeRepository.getByThreadId({ threadId });
      assert.equal(Option.isSome(runtime), true);
      if (Option.isSome(runtime)) {
        assert.equal(runtime.value.threadId, threadId);
        assert.equal(runtime.value.status, "running");
        assert.deepEqual(runtime.value.resumeCursor, {
          threadId: "provider-thread-runtime",
        });
        assert.deepEqual(runtime.value.runtimePayload, {
          cwd: "/tmp/project",
          model: "gpt-5-codex",
          activeTurnId: "turn-1",
        });
      }
    }),
  );

  it.effect("keeps the existing binding when an insert conflicts", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-insert-conflict");

      yield* directory.upsert({
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        threadId,
        status: "running",
        resumeCursor: { threadId: "active-provider-thread" },
      });

      yield* directory.upsert(
        {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
          status: "stopped",
          resumeCursor: { threadId: "stale-provider-thread" },
        },
        { onConflict: "ignore" },
      );

      const binding = yield* directory.getBinding(threadId);
      expect(Option.getOrThrow(binding)).toMatchObject({
        threadId,
        status: "running",
        resumeCursor: { threadId: "active-provider-thread" },
      });
    }),
  );

  it.effect("records source files without replacing the current provider session", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const source = { ...importedSource, providerSessionId: "record-source" };
      const threadId = ThreadId.make(
        `import:${source.providerInstanceId}:${source.providerSessionId}`,
      );
      const runtimePayload = { cwd: "/tmp/project", activeTurnId: "active-turn" };
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claude-current"),
        status: "running",
        resumeCursor: { resume: "current-native-session" },
        runtimePayload,
      });
      const before = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));

      yield* directory.recordImportedTranscript({ threadId, source });
      const replacement = { ...source, size: 200, mtimeMs: 2_000 };
      yield* directory.recordImportedTranscript({ threadId, source: replacement });
      const secondFile = { ...source, filePath: "/tmp/provider-session-copy.jsonl" };
      yield* directory.recordImportedTranscript({ threadId, source: secondFile });

      expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId }))).toEqual({
        ...before,
        runtimePayload: { ...runtimePayload, importedTranscripts: [replacement, secondFile] },
      });
    }),
  );

  it.effect("does not create a binding when recording an imported transcript", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("import:codex:missing-source-binding");

      yield* directory.recordImportedTranscript({ threadId, source: importedSource });

      expect(Option.isNone(yield* directory.getBinding(threadId))).toBe(true);
    }),
  );

  it.effect("keeps newly recorded sources when a runtime write uses a stale payload", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const firstSource = { ...importedSource, providerSessionId: "stale-source" };
      const threadId = ThreadId.make(
        `import:${firstSource.providerInstanceId}:${firstSource.providerSessionId}`,
      );
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        status: "stopped",
        resumeCursor: { threadId: "original-native-session" },
        runtimePayload: { cwd: "/tmp/stale-source-project" },
      });
      yield* directory.recordImportedTranscript({ threadId, source: firstSource });
      const stale = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      const secondSource = { ...firstSource, filePath: "/tmp/stale-source-copy.jsonl" };
      yield* directory.recordImportedTranscript({ threadId, source: secondSource });

      yield* repository.upsert({
        ...stale,
        status: "running",
        resumeCursor: { threadId: "new-native-session" },
        lastSeenAt: "2026-08-24T10:00:00.000Z",
      });

      expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId }))).toEqual({
        ...stale,
        status: "running",
        resumeCursor: { threadId: "new-native-session" },
        lastSeenAt: "2026-08-24T10:00:00.000Z",
        runtimePayload: {
          cwd: "/tmp/stale-source-project",
          importedTranscripts: [firstSource, secondSource],
        },
      });
    }),
  );

  it.effect("reserves imported source records for the atomic recording method", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      for (const onConflict of ["update", "ignore"] as const) {
        const source = { ...importedSource, providerSessionId: `reserved-source-${onConflict}` };
        const threadId = ThreadId.make(
          `import:${source.providerInstanceId}:${source.providerSessionId}`,
        );
        const binding = {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        };
        yield* directory.upsert(
          { ...binding, runtimePayload: { cwd: "/tmp/project", importedTranscripts: [source] } },
          { onConflict },
        );
        expect(Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload).toEqual({
          cwd: "/tmp/project",
        });

        yield* directory.recordImportedTranscript({ threadId, source });
        yield* directory.upsert({ ...binding, runtimePayload: null });

        expect(Option.getOrThrow(yield* directory.getBinding(threadId)).runtimePayload).toEqual({
          importedTranscripts: [source],
        });
      }
    }),
  );

  it.effect("lists persisted bindings with metadata in oldest-first order", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;

      const olderThreadId = ThreadId.make("thread-runtime-older");
      const newerThreadId = ThreadId.make("thread-runtime-newer");

      yield* runtimeRepository.upsert({
        threadId: newerThreadId,
        providerName: "codex",
        providerInstanceId: null,
        adapterKey: "codex",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T12:05:00.000Z",
        resumeCursor: {
          opaque: "resume-newer",
        },
        runtimePayload: {
          cwd: "/tmp/newer",
        },
      });

      yield* runtimeRepository.upsert({
        threadId: olderThreadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "approval-required",
        status: "starting",
        lastSeenAt: "2026-04-14T12:00:00.000Z",
        resumeCursor: {
          opaque: "resume-older",
        },
        runtimePayload: {
          cwd: "/tmp/older",
        },
      });

      const bindings = (yield* directory.listBindings()).filter(
        (binding) => binding.threadId === olderThreadId || binding.threadId === newerThreadId,
      );

      assert.deepEqual(bindings, [
        {
          threadId: olderThreadId,
          provider: ProviderDriverKind.make("claudeAgent"),
          providerInstanceId: ProviderInstanceId.make("claudeAgent"),
          adapterKey: "claudeAgent",
          runtimeMode: "approval-required",
          status: "starting",
          lastSeenAt: "2026-04-14T12:00:00.000Z",
          resumeCursor: {
            opaque: "resume-older",
          },
          runtimePayload: {
            cwd: "/tmp/older",
          },
        },
        {
          threadId: newerThreadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          adapterKey: "codex",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-04-14T12:05:00.000Z",
          resumeCursor: {
            opaque: "resume-newer",
          },
          runtimePayload: {
            cwd: "/tmp/newer",
          },
        },
      ]);
    }),
  );

  it.effect("lists only bindings that are not stopped when asked", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const statuses = ["running", "starting", "error", "stopped"] as const;
      const threadIds = new Set<string>();

      for (const status of statuses) {
        const threadId = ThreadId.make(`thread-exclude-stopped-${status}`);
        threadIds.add(threadId);
        yield* runtimeRepository.upsert({
          threadId,
          providerName: "codex",
          providerInstanceId: ProviderInstanceId.make("codex"),
          adapterKey: "codex",
          runtimeMode: "full-access",
          status,
          lastSeenAt: "2026-04-14T12:00:00.000Z",
          resumeCursor: null,
          runtimePayload: null,
        });
      }

      const liveStatuses = (yield* directory.listBindings({ excludeStopped: true }))
        .filter((binding) => threadIds.has(binding.threadId))
        .map((binding) => binding.status);
      const allStatuses = (yield* directory.listBindings())
        .filter((binding) => threadIds.has(binding.threadId))
        .map((binding) => binding.status);

      assert.deepEqual(liveStatuses.toSorted(), ["error", "running", "starting"]);
      assert.deepEqual(allStatuses.toSorted(), ["error", "running", "starting", "stopped"]);
    }),
  );

  it.effect(
    "resets adapterKey to the new provider when provider changes without an explicit adapter key",
    () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-provider-change");

        yield* runtimeRepository.upsert({
          threadId,
          providerName: "claudeAgent",
          providerInstanceId: null,
          adapterKey: "claudeAgent",
          runtimeMode: "full-access",
          status: "running",
          lastSeenAt: "2026-01-01T00:00:00.000Z",
          resumeCursor: null,
          runtimePayload: null,
        });

        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
        });

        const runtime = yield* runtimeRepository.getByThreadId({ threadId });
        assert.equal(Option.isSome(runtime), true);
        if (Option.isSome(runtime)) {
          assert.equal(runtime.value.providerName, "codex");
          assert.equal(runtime.value.adapterKey, "codex");
        }
      }),
  );

  it.effect("rehydrates persisted mappings across layer restart", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-directory-"));
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      // Each provide builds this layer fresh on a local memo map, so the
      // second build is a real restart against the same dbPath rather than
      // the outer it.layer's in-memory instance.
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.make("thread-restart");

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
        });
      }).pipe(Effect.provide(directoryLayer, { local: true }));

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const sql = yield* SqlClient.SqlClient;
        const provider = yield* directory.getProvider(threadId);
        assert.equal(provider, "codex");

        const resolvedBinding = yield* directory.getBinding(threadId);
        expect(Option.getOrThrow(resolvedBinding)).toMatchObject({
          threadId,
          provider: ProviderDriverKind.make("codex"),
        });
        if (Option.isSome(resolvedBinding)) {
          assert.equal(resolvedBinding.value.threadId, threadId);
        }

        const legacyTableRows = yield* sql<{ readonly name: string }>`
          SELECT name
          FROM sqlite_master
          WHERE type = 'table' AND name = 'provider_sessions'
        `;
        assert.equal(legacyTableRows.length, 0);
      }).pipe(Effect.provide(directoryLayer, { local: true }));

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }),
  );

  it.effect("serializes concurrent upserts so neither merge is lost", () =>
    Effect.gen(function* () {
      const upsertEntered = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const readerEntered = yield* Deferred.make<void>();
      const layer = makeProbedDirectoryLayer(
        writeProbes({ upsertEntered, releaseUpsert, readerEntered }),
      );

      const fibers: Fiber.Fiber<unknown, unknown>[] = [];

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-serialized-writes");
        const binding = {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as const;

        const first = yield* Effect.forkChild(
          directory.upsert({ ...binding, runtimePayload: { first: true } }),
        );
        fibers.push(first);
        // The first writer holds the thread lock parked inside the
        // repository write.
        yield* Deferred.await(upsertEntered);

        const second = yield* Effect.forkChild(
          directory.upsert({ ...binding, runtimePayload: { second: true } }),
        );
        fibers.push(second);
        yield* Effect.yieldNow;
        // The second writer is parked on the thread lock: it has not reached
        // the repository for its read.
        expect(yield* Deferred.isDone(readerEntered)).toBe(false);

        yield* Deferred.succeed(releaseUpsert, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        // The second writer read after the first write committed, so its
        // merge saw the first payload: no lost update.
        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        assert.deepEqual(runtime.runtimePayload, { first: true, second: true });
      }).pipe(
        // Release any writer parked in the uninterruptible repository
        // write, then drain every spawned fiber — all inside the provided
        // region, so the local layer's scope closes only after writers
        // finish. interruptAll is a no-op on fibers that already exited.
        Effect.ensuring(
          Deferred.succeed(releaseUpsert, undefined).pipe(
            Effect.andThen(Fiber.interruptAll(fibers)),
          ),
        ),
        Effect.provide(layer, { local: true }),
      );
    }),
  );

  it.effect("never blocks one thread's write on another thread's lock", () =>
    Effect.gen(function* () {
      const upsertEntered = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const otherUpsertEntered = yield* Deferred.make<void>();
      let upsertCalls = 0;
      const layer = makeProbedDirectoryLayer((real) => ({
        upsert: (runtime, options) =>
          Effect.suspend(() => {
            upsertCalls++;
            if (upsertCalls === 1) {
              return Deferred.succeed(upsertEntered, undefined).pipe(
                Effect.andThen(Deferred.await(releaseUpsert)),
                Effect.andThen(real.upsert(runtime, options)),
              );
            }
            return Deferred.succeed(otherUpsertEntered, undefined).pipe(
              Effect.andThen(real.upsert(runtime, options)),
            );
          }),
      }));

      const fibers: Fiber.Fiber<unknown, unknown>[] = [];

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const heldThreadId = ThreadId.make("thread-lock-held");
        const freeThreadId = ThreadId.make("thread-lock-free");
        const binding = {
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as const;

        const holder = yield* Effect.forkChild(
          directory.upsert({ ...binding, threadId: heldThreadId, runtimePayload: { held: true } }),
        );
        fibers.push(holder);
        // The holder is parked inside its repository write with the lock for
        // `heldThreadId` taken.
        yield* Deferred.await(upsertEntered);

        const other = yield* Effect.forkChild(
          directory.upsert({ ...binding, threadId: freeThreadId, runtimePayload: { free: true } }),
        );
        fibers.push(other);
        // A different thread never waits: it reached its own repository
        // write while the first lock is still held. Were the lock shared,
        // this await could not resolve until the holder released.
        yield* Deferred.await(otherUpsertEntered);

        yield* Deferred.succeed(releaseUpsert, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(other);

        assert.deepEqual(
          Option.getOrThrow(yield* repository.getByThreadId({ threadId: heldThreadId }))
            .runtimePayload,
          { held: true },
        );
        assert.deepEqual(
          Option.getOrThrow(yield* repository.getByThreadId({ threadId: freeThreadId }))
            .runtimePayload,
          { free: true },
        );
      }).pipe(
        // Release any writer parked in the uninterruptible repository
        // write, then drain every spawned fiber — all inside the provided
        // region, so the local layer's scope closes only after writers
        // finish. interruptAll is a no-op on fibers that already exited.
        Effect.ensuring(
          Deferred.succeed(releaseUpsert, undefined).pipe(
            Effect.andThen(Fiber.interruptAll(fibers)),
          ),
        ),
        Effect.provide(layer, { local: true }),
      );
    }),
  );

  it.effect("completes an admitted upsertIf write before a queued write wins", () =>
    Effect.gen(function* () {
      const upsertEntered = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const readerEntered = yield* Deferred.make<void>();
      const layer = makeProbedDirectoryLayer(
        writeProbes({ upsertEntered, releaseUpsert, readerEntered }),
      );

      const fibers: Fiber.Fiber<unknown, unknown>[] = [];

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-admitted-then-stop");
        const binding = {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as const;

        let admitted = true;
        const conditional = yield* Effect.forkChild(
          directory.upsertIf(
            { ...binding, status: "running", runtimePayload: { admitted: true } },
            () => admitted,
          ),
        );
        fibers.push(conditional);
        yield* Deferred.await(upsertEntered);

        // The predicate was already true at admission. Flipping it now must
        // not cancel the admitted write, and the queued writer runs only
        // after it finishes.
        admitted = false;
        const stop = yield* Effect.forkChild(directory.upsert({ ...binding, status: "stopped" }));
        fibers.push(stop);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(readerEntered)).toBe(false);

        yield* Deferred.succeed(releaseUpsert, undefined);
        expect(yield* Fiber.join(conditional)).toBe(true);
        yield* Fiber.join(stop);

        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        assert.equal(runtime.status, "stopped");
        // The queued write merged over the admitted row: the admitted write
        // committed first and the later write supplied the final state.
        assert.deepEqual(runtime.runtimePayload, { admitted: true });
      }).pipe(
        // Release any writer parked in the uninterruptible repository
        // write, then drain every spawned fiber — all inside the provided
        // region, so the local layer's scope closes only after writers
        // finish. interruptAll is a no-op on fibers that already exited.
        Effect.ensuring(
          Deferred.succeed(releaseUpsert, undefined).pipe(
            Effect.andThen(Fiber.interruptAll(fibers)),
          ),
        ),
        Effect.provide(layer, { local: true }),
      );
    }),
  );

  it.effect("evaluates the upsertIf predicate under the lock and skips a false write", () =>
    Effect.gen(function* () {
      const upsertEntered = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const readerEntered = yield* Deferred.make<void>();
      const layer = makeProbedDirectoryLayer(
        writeProbes({ upsertEntered, releaseUpsert, readerEntered }),
      );

      const fibers: Fiber.Fiber<unknown, unknown>[] = [];

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-false-predicate");
        const binding = {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as const;

        const holder = yield* Effect.forkChild(
          directory.upsert({ ...binding, runtimePayload: { holder: true } }),
        );
        fibers.push(holder);
        yield* Deferred.await(upsertEntered);

        let predicateCalls = 0;
        const conditional = yield* Effect.forkChild(
          directory.upsertIf({ ...binding, status: "stopped" }, () => {
            predicateCalls++;
            return false;
          }),
        );
        fibers.push(conditional);
        yield* Effect.yieldNow;
        // Parked on the lock, the conditional has not evaluated `when` yet.
        expect(predicateCalls).toBe(0);
        expect(yield* Deferred.isDone(readerEntered)).toBe(false);

        yield* Deferred.succeed(releaseUpsert, undefined);
        yield* Fiber.join(holder);
        expect(yield* Fiber.join(conditional)).toBe(false);
        expect(predicateCalls).toBe(1);
        // A false predicate runs no repository read or write at all, so the
        // holder's row stands untouched.
        expect(yield* Deferred.isDone(readerEntered)).toBe(false);
        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        assert.deepEqual(runtime.runtimePayload, { holder: true });
      }).pipe(
        // Release any writer parked in the uninterruptible repository
        // write, then drain every spawned fiber — all inside the provided
        // region, so the local layer's scope closes only after writers
        // finish. interruptAll is a no-op on fibers that already exited.
        Effect.ensuring(
          Deferred.succeed(releaseUpsert, undefined).pipe(
            Effect.andThen(Fiber.interruptAll(fibers)),
          ),
        ),
        Effect.provide(layer, { local: true }),
      );
    }),
  );

  it.effect("keeps the thread lock when a queued writer is interrupted", () =>
    Effect.gen(function* () {
      const upsertEntered = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const readerEntered = yield* Deferred.make<void>();
      const layer = makeProbedDirectoryLayer(
        writeProbes({ upsertEntered, releaseUpsert, readerEntered }),
      );

      const fibers: Fiber.Fiber<unknown, unknown>[] = [];

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-interrupted-waiter");
        const binding = {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as const;

        const holder = yield* Effect.forkChild(
          directory.upsert({ ...binding, runtimePayload: { holder: true } }),
        );
        fibers.push(holder);
        yield* Deferred.await(upsertEntered);

        const waiter = yield* Effect.forkChild(
          directory.upsert({ ...binding, status: "error", runtimePayload: { waiter: true } }),
        );
        fibers.push(waiter);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(readerEntered)).toBe(false);

        // Interrupting a parked waiter must not eat the held permit nor
        // strand the lock for writers queued behind it.
        yield* Fiber.interrupt(waiter);
        const waiterExit = yield* Fiber.await(waiter);
        assert.ok(Exit.isFailure(waiterExit));
        if (Exit.isFailure(waiterExit)) {
          assert.ok(Cause.hasInterrupts(waiterExit.cause));
        }

        const third = yield* Effect.forkChild(
          directory.upsert({ ...binding, runtimePayload: { third: true } }),
        );
        fibers.push(third);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(readerEntered)).toBe(false);

        yield* Deferred.succeed(releaseUpsert, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(third);

        // The permit survived the interruption: the third writer ran,
        // merged over the holder, and the interrupted writer wrote nothing.
        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        assert.equal(runtime.status, "running");
        assert.deepEqual(runtime.runtimePayload, { holder: true, third: true });
      }).pipe(
        // Release any writer parked in the uninterruptible repository
        // write, then drain every spawned fiber — all inside the provided
        // region, so the local layer's scope closes only after writers
        // finish. interruptAll is a no-op on fibers that already exited.
        Effect.ensuring(
          Deferred.succeed(releaseUpsert, undefined).pipe(
            Effect.andThen(Fiber.interruptAll(fibers)),
          ),
        ),
        Effect.provide(layer, { local: true }),
      );
    }),
  );

  it.effect("dies on an inherited sql transaction before locking or writing", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-nested-transaction");
      const binding = {
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      } as const;

      const writers = [
        ["upsert", directory.upsert({ ...binding, status: "error" })],
        ["upsertIf", directory.upsertIf({ ...binding, status: "error" }, () => true)],
        ["upsertIfCurrent", directory.upsertIfCurrent({ ...binding, status: "error" }, () => true)],
        [
          "recordImportedTranscript",
          directory.recordImportedTranscript({ threadId, source: importedSource }),
        ],
      ] as const;

      for (const [name, writer] of writers) {
        const exit = yield* Effect.exit(sql.withTransaction(writer));
        assert.ok(Exit.isFailure(exit), `${name} must fail inside sql.withTransaction`);
        if (Exit.isFailure(exit)) {
          // A programming fault surfaces as a defect raised before the lock
          // or the repository, never as a typed error.
          assert.ok(exit.cause.reasons.some(Cause.isDieReason));
        }
        assert.ok(
          Option.isNone(yield* directory.getBinding(threadId)),
          `${name} must not write inside sql.withTransaction`,
        );
      }

      // The defect ran before lock registration, so nothing leaked: the
      // same writers work normally outside a transaction.
      yield* directory.upsert({ ...binding, runtimePayload: { cwd: "/tmp/tx-check" } });
      expect(yield* directory.upsertIf({ ...binding, status: "stopped" }, () => false)).toBe(false);
      yield* directory.recordImportedTranscript({ threadId, source: importedSource });
      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      assert.equal(runtime.status, "running");
      assert.deepEqual(runtime.runtimePayload, {
        cwd: "/tmp/tx-check",
        importedTranscripts: [importedSource],
      });
    }),
  );

  it.effect("preserves imported transcripts across interleaved locked writes", () =>
    Effect.gen(function* () {
      const upsertEntered = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const transcriptEntered = yield* Deferred.make<void>();
      let transcriptCalls = 0;
      const layer = makeProbedDirectoryLayer((real) => ({
        // The seed upsert is call one; the conditional write below is call
        // two and is the one held at the barrier.
        ...writeProbes({ upsertEntered, releaseUpsert, gateUpsertCall: 2 })(real),
        recordImportedTranscript: (input) =>
          Effect.suspend(() => {
            transcriptCalls++;
            return transcriptCalls === 1
              ? real.recordImportedTranscript(input)
              : Deferred.succeed(transcriptEntered, undefined).pipe(
                  Effect.andThen(real.recordImportedTranscript(input)),
                );
          }),
      }));

      const fibers: Fiber.Fiber<unknown, unknown>[] = [];

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const sourceA = { ...importedSource, providerSessionId: "interleaved-a" };
        const sourceB = {
          ...importedSource,
          providerSessionId: "interleaved-b",
          filePath: "/tmp/interleaved-b.jsonl",
        };
        const threadId = ThreadId.make("thread-interleaved-transcript");
        const binding = {
          threadId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
        } as const;

        yield* directory.upsert({
          ...binding,
          status: "starting",
          runtimePayload: { cwd: "/tmp/interleaved" },
        });
        yield* directory.recordImportedTranscript({ threadId, source: sourceA });

        // The transcript writer shares the thread lock: while the
        // conditional write holds it, the transcript call queues behind it.
        const conditional = yield* Effect.forkChild(
          directory.upsertIf(
            { ...binding, status: "running", runtimePayload: { activeTurnId: "turn-x" } },
            () => true,
          ),
        );
        fibers.push(conditional);
        yield* Deferred.await(upsertEntered);
        const transcript = yield* Effect.forkChild(
          directory.recordImportedTranscript({ threadId, source: sourceB }),
        );
        fibers.push(transcript);
        yield* Effect.yieldNow;
        expect(yield* Deferred.isDone(transcriptEntered)).toBe(false);

        yield* Deferred.succeed(releaseUpsert, undefined);
        expect(yield* Fiber.join(conditional)).toBe(true);
        yield* Fiber.join(transcript);

        // A skipped conditional write disturbs neither the recorded sources
        // nor the running binding.
        const skipped = yield* directory.upsertIf(
          { ...binding, status: "stopped", runtimePayload: null },
          () => false,
        );
        expect(skipped).toBe(false);

        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        assert.equal(runtime.status, "running");
        assert.deepEqual(runtime.runtimePayload, {
          cwd: "/tmp/interleaved",
          activeTurnId: "turn-x",
          importedTranscripts: [sourceA, sourceB],
        });
      }).pipe(
        // Release any writer parked in the uninterruptible repository
        // write, then drain every spawned fiber — all inside the provided
        // region, so the local layer's scope closes only after writers
        // finish. interruptAll is a no-op on fibers that already exited.
        Effect.ensuring(
          Deferred.succeed(releaseUpsert, undefined).pipe(
            Effect.andThen(Fiber.interruptAll(fibers)),
          ),
        ),
        Effect.provide(layer, { local: true }),
      );
    }),
  );

  it.effect(
    "hands the upsertIfCurrent predicate the current row and patches only its own fields",
    () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-if-current-merge");
        const resumeCursor = { threadId: "provider-thread-if-current" };

        yield* directory.upsert({
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          threadId,
          status: "starting",
          resumeCursor,
          runtimePayload: { cwd: "/tmp/if-current", model: "gpt-5-codex" },
        });

        let predicateCalls = 0;
        const wrote = yield* directory.upsertIfCurrent(
          {
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            threadId,
            status: "stopped",
            runtimePayload: { activeTurnId: null },
          },
          (current) => {
            predicateCalls++;
            const row = Option.getOrThrow(current);
            expect(row).toMatchObject({
              threadId,
              provider: ProviderDriverKind.make("codex"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              status: "starting",
              resumeCursor,
              runtimePayload: { cwd: "/tmp/if-current", model: "gpt-5-codex" },
            });
            return row.status === "starting";
          },
        );

        assert.equal(predicateCalls, 1);
        assert.equal(wrote, true);

        // Only the patch's own fields changed: the resume cursor the
        // predicate saw stands untouched and the payload merged instead of
        // replacing the stored one.
        const runtime = Option.getOrThrow(yield* runtimeRepository.getByThreadId({ threadId }));
        assert.equal(runtime.status, "stopped");
        assert.deepEqual(runtime.resumeCursor, resumeCursor);
        assert.deepEqual(runtime.runtimePayload, {
          cwd: "/tmp/if-current",
          model: "gpt-5-codex",
          activeTurnId: null,
        });
      }),
  );

  it.effect("writes nothing when the upsertIfCurrent predicate rejects the current row", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const runtimeRepository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const identity = {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
      } as const;

      // No row exists yet: the predicate judges None, refuses, and no row
      // is created.
      const emptyThreadId = ThreadId.make("thread-if-current-empty");
      const created = yield* directory.upsertIfCurrent(
        { ...identity, threadId: emptyThreadId, status: "running" },
        (current) => {
          assert.equal(Option.isNone(current), true);
          return false;
        },
      );
      assert.equal(created, false);
      assert.equal(Option.isNone(yield* directory.getBinding(emptyThreadId)), true);

      // A stored row survives a rejecting predicate byte-for-byte,
      // lastSeenAt included, so any write would fail this comparison.
      const threadId = ThreadId.make("thread-if-current-rejected");
      yield* directory.upsert({
        ...identity,
        threadId,
        status: "starting",
        resumeCursor: { threadId: "provider-thread-rejected" },
        runtimePayload: { cwd: "/tmp/rejected" },
      });
      const before = Option.getOrThrow(yield* runtimeRepository.getByThreadId({ threadId }));

      const wrote = yield* directory.upsertIfCurrent(
        { ...identity, threadId, status: "stopped", runtimePayload: null },
        (current) => Option.isSome(current) && current.value.status === "running",
      );

      assert.equal(wrote, false);
      expect(Option.getOrThrow(yield* runtimeRepository.getByThreadId({ threadId }))).toEqual(
        before,
      );
    }),
  );

  it.effect(
    "evaluates the upsertIfCurrent predicate under the lock against the committed row",
    () =>
      Effect.gen(function* () {
        const upsertEntered = yield* Deferred.make<void>();
        const releaseUpsert = yield* Deferred.make<void>();
        const readerEntered = yield* Deferred.make<void>();
        const layer = makeProbedDirectoryLayer(
          writeProbes({ upsertEntered, releaseUpsert, readerEntered }),
        );

        const fibers: Fiber.Fiber<unknown, unknown>[] = [];

        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory;
          const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          const threadId = ThreadId.make("thread-if-current-lock");
          const binding = {
            threadId,
            provider: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
          } as const;

          const holder = yield* Effect.forkChild(
            directory.upsert({ ...binding, runtimePayload: { holder: true } }),
          );
          fibers.push(holder);
          // The holder parks inside its repository write owning the thread
          // lock.
          yield* Deferred.await(upsertEntered);

          const conditional = yield* Effect.forkChild(
            directory.upsertIfCurrent(
              { ...binding, status: "stopped", runtimePayload: { cleaned: true } },
              (current) => {
                // The predicate judged the row the holder just committed,
                // not a pre-lock snapshot.
                expect(Option.getOrThrow(current)).toMatchObject({
                  status: "running",
                  runtimePayload: { holder: true },
                });
                return Option.isSome(current) && current.value.status === "running";
              },
            ),
          );
          fibers.push(conditional);
          yield* Effect.yieldNow;
          // Parked on the lock: the predicate has not run and its read of
          // the current row has not reached the repository.
          expect(yield* Deferred.isDone(readerEntered)).toBe(false);

          yield* Deferred.succeed(releaseUpsert, undefined);
          expect(yield* Fiber.join(conditional)).toBe(true);
          yield* Fiber.join(holder);

          const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
          assert.equal(runtime.status, "stopped");
          assert.deepEqual(runtime.runtimePayload, { holder: true, cleaned: true });
        }).pipe(
          // Release any writer parked in the uninterruptible repository
          // write, then drain every spawned fiber — all inside the provided
          // region, so the local layer's scope closes only after writers
          // finish. interruptAll is a no-op on fibers that already exited.
          Effect.ensuring(
            Deferred.succeed(releaseUpsert, undefined).pipe(
              Effect.andThen(Fiber.interruptAll(fibers)),
            ),
          ),
          Effect.provide(layer, { local: true }),
        );
      }),
  );

  it.effect("preserves prior native session ids when the resume cursor moves", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-move");
      const identity = claudeIdentity(threadId);

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionC),
      });

      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(runtime.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionC));
      expect(runtime.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA), claudeRef(claudeSessionB)],
      });
    }),
  );

  it.effect("does not grow preserved refs while every update keeps the same session id", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-same-id");
      const identity = claudeIdentity(threadId);

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      for (const turn of [1, 2, 3]) {
        yield* directory.upsert({
          ...identity,
          resumeCursor: { threadId, resume: claudeSessionB, turnCount: turn },
          runtimePayload: { cwd: "/tmp/same-id" },
        });
      }

      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(runtime.runtimePayload).toEqual({
        cwd: "/tmp/same-id",
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA)],
      });
    }),
  );

  it.effect("keeps preserved refs through an explicit cursor reset and a null payload", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-null-reset");
      const identity = claudeIdentity(threadId);

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      // Explicit reset to null keeps the id the cursor used to point at.
      yield* directory.upsert({ ...identity, resumeCursor: null });
      const afterReset = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      assert.deepEqual(afterReset.resumeCursor, null);
      expect(afterReset.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA), claudeRef(claudeSessionB)],
      });

      // An explicit null payload reconstructs the refs instead of erasing.
      yield* directory.upsert({ ...identity, runtimePayload: null });
      const afterNullPayload = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(afterNullPayload.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA), claudeRef(claudeSessionB)],
      });
    }),
  );

  it.effect("keeps the original provenance when the provider switches", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-provider-switch");

      yield* directory.upsert({
        ...claudeIdentity(threadId),
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        resumeCursor: { threadId: codexNativeThread },
      });

      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      assert.equal(runtime.providerName, "codex");
      assert.equal(runtime.providerInstanceId, "codex");
      assert.equal(runtime.adapterKey, "codex");
      expect(runtime.resumeCursor).toEqual({ threadId: codexNativeThread });
      // The old Claude ref is stored under the instance that produced it,
      // never reinterpreted as a Codex id.
      expect(runtime.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA)],
      });
    }),
  );

  it.effect("preserves both provenances when one session id moves across instance aliases", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-alias");
      const aliasIdentity = {
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claude-alias"),
      } as const;

      yield* directory.upsert({
        ...claudeIdentity(threadId),
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      // The same session id under another configured instance: the original
      // claude-current ref is stored before the alias takes over the row.
      yield* directory.upsert({
        ...aliasIdentity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      // Moving on to a new session preserves the alias provenance too.
      yield* directory.upsert({
        ...aliasIdentity,
        resumeCursor: claudeCursor(threadId, claudeSessionC),
      });

      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      assert.equal(runtime.providerInstanceId, "claude-alias");
      expect(runtime.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionC));
      expect(runtime.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [
          claudeRef(claudeSessionA),
          claudeRef(claudeSessionA, "claude-alias"),
        ],
      });
    }),
  );

  it.effect("a next payload's alias ref cannot erase the older current provenance", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-alias-ordering");

      yield* directory.upsert({
        ...claudeIdentity(threadId),
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      // A writer under the alias identity records the same session id under
      // its own instance while moving the cursor to a new session. The
      // payload's alias ref is stored first and the demoted current ref is
      // appended — the older provenance survives the write order.
      yield* directory.upsert({
        threadId,
        provider: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claude-alias"),
        resumeCursor: claudeCursor(threadId, claudeSessionB),
        runtimePayload: {
          [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA, "claude-alias")],
        },
      });

      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(runtime.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionB));
      expect(runtime.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [
          claudeRef(claudeSessionA, "claude-alias"),
          claudeRef(claudeSessionA),
        ],
      });
    }),
  );

  it.effect("stale payloads and stale cursors cannot erase preserved history", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-stale");
      const identity = claudeIdentity(threadId);

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionC),
      });

      // A stale writer with an explicit null payload, an omitted cursor,
      // and a fresh payload can only carry the history forward.
      yield* directory.upsert({ ...identity, runtimePayload: null });
      const afterNull = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(afterNull.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA), claudeRef(claudeSessionB)],
      });
      yield* directory.upsert({ ...identity, runtimePayload: { activeTurnId: "stale-turn" } });
      const afterStale = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(afterStale.runtimePayload).toEqual({
        activeTurnId: "stale-turn",
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA), claudeRef(claudeSessionB)],
      });

      // A stale replay of an older cursor moves the cursor back and demotes
      // the newer id into the preserved list — it never drops one.
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      const afterReplay = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(afterReplay.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionB));
      expect(afterReplay.runtimePayload).toEqual({
        activeTurnId: "stale-turn",
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [
          claudeRef(claudeSessionA),
          claudeRef(claudeSessionB),
          claudeRef(claudeSessionC),
        ],
      });
    }),
  );

  it.effect("records imported transcripts without disturbing preserved refs", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-transcript");
      const identity = claudeIdentity(threadId);
      const source = {
        ...importedSource,
        provider: "claudeAgent" as const,
        providerInstanceId: ProviderInstanceId.make("claude-current"),
        providerSessionId: claudeSessionA,
        filePath: "/tmp/claude-a.jsonl",
      };

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      yield* directory.recordImportedTranscript({ threadId, source });

      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(runtime.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA)],
        importedTranscripts: [source],
      });
    }),
  );

  it.effect("keeps the stored refs byte-for-byte when a conflict-ignore upsert loses", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-ignore-loser");
      const identity = claudeIdentity(threadId);

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      const before = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));

      yield* directory.upsert(
        {
          ...identity,
          status: "stopped",
          resumeCursor: claudeCursor(threadId, claudeSessionC),
          runtimePayload: { sneak: true },
        },
        { onConflict: "ignore" },
      );

      // The loser wrote nothing: not its status, not its cursor, not its
      // payload, and lastSeenAt is untouched too.
      expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId }))).toEqual(before);
    }),
  );

  it.effect("writes nothing over preserved refs when an upsertIf predicate refuses", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-refused");
      const identity = claudeIdentity(threadId);

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      const before = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));

      const wrote = yield* directory.upsertIf(
        { ...identity, status: "stopped", runtimePayload: null },
        () => false,
      );
      assert.equal(wrote, false);
      expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId }))).toEqual(before);
    }),
  );

  it.effect("stores no refs metadata for providers whose cursors it cannot read", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-opaque");
      const identity = {
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        providerInstanceId: ProviderInstanceId.make("cursor"),
      } as const;

      yield* directory.upsert({ ...identity, runtimePayload: { cwd: "/tmp/opaque" } });
      yield* directory.upsert({
        ...identity,
        resumeCursor: { opaque: "resume-2" },
        runtimePayload: { model: "cursor-model" },
      });

      const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
      expect(runtime.resumeCursor).toEqual({ opaque: "resume-2" });
      expect(runtime.runtimePayload).toEqual({ cwd: "/tmp/opaque", model: "cursor-model" });
    }),
  );

  it.effect("fails the upsert on malformed stored refs metadata and leaves the row untouched", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const threadId = ThreadId.make("thread-prior-refs-malformed");
      const identity = claudeIdentity(threadId);

      yield* repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claude-current"),
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-08-24T10:00:00.000Z",
        resumeCursor: { resume: claudeSessionA },
        runtimePayload: { cwd: "/tmp/malformed", [PRIOR_PROVIDER_SESSION_IDS_KEY]: "claude" },
      });
      const before = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));

      const outcome = yield* Effect.result(
        directory.upsert({ ...identity, status: "stopped", runtimePayload: { sneak: true } }),
      );
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") {
        // Malformed metadata is a loud ownership-lookup failure, never a
        // silent fall-through to an empty preserved set.
        expect(outcome.failure._tag).toBe("ProviderValidationError");
      }
      expect(Option.getOrThrow(yield* repository.getByThreadId({ threadId }))).toEqual(before);
    }),
  );

  it.effect("serializes a stale queued writer so its payload cannot erase newer refs", () =>
    Effect.gen(function* () {
      const upsertEntered = yield* Deferred.make<void>();
      const releaseUpsert = yield* Deferred.make<void>();
      const readerEntered = yield* Deferred.make<void>();
      const layer = makeProbedDirectoryLayer(
        writeProbes({ upsertEntered, releaseUpsert, readerEntered }),
      );

      const fibers: Fiber.Fiber<unknown, unknown>[] = [];

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-prior-refs-serialized");
        const identity = claudeIdentity(threadId);
        // Seeded through raw SQL so the two writers below are probe calls
        // one and two, exactly like the other serialization tests.
        yield* sql`
          INSERT INTO provider_session_runtime (
            thread_id,
            provider_name,
            provider_instance_id,
            adapter_key,
            runtime_mode,
            status,
            last_seen_at,
            resume_cursor_json,
            runtime_payload_json
          )
          VALUES (
            ${threadId},
            'claudeAgent',
            'claude-current',
            'claudeAgent',
            'full-access',
            'running',
            '2026-08-24T10:00:00.000Z',
            ${JSON.stringify(claudeCursor(threadId, claudeSessionA))},
            ${JSON.stringify({ cwd: "/tmp/refs" })}
          )
        `;

        const first = yield* Effect.forkChild(
          directory.upsert({
            ...identity,
            resumeCursor: claudeCursor(threadId, claudeSessionB),
            runtimePayload: { first: true },
          }),
        );
        fibers.push(first);
        // The first writer holds the thread lock parked inside the
        // repository write.
        yield* Deferred.await(upsertEntered);

        const second = yield* Effect.forkChild(
          directory.upsert({
            ...identity,
            resumeCursor: claudeCursor(threadId, claudeSessionC),
            runtimePayload: { second: true },
          }),
        );
        fibers.push(second);
        yield* Effect.yieldNow;
        // Parked on the lock: the stale writer has not read the row yet.
        expect(yield* Deferred.isDone(readerEntered)).toBe(false);

        yield* Deferred.succeed(releaseUpsert, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);

        // The second writer read after the first committed: its merge saw
        // the first payload and the refs grew instead of resetting.
        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        expect(runtime.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionC));
        expect(runtime.runtimePayload).toEqual({
          cwd: "/tmp/refs",
          first: true,
          second: true,
          [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA), claudeRef(claudeSessionB)],
        });
      }).pipe(
        Effect.ensuring(
          Deferred.succeed(releaseUpsert, undefined).pipe(
            Effect.andThen(Fiber.interruptAll(fibers)),
          ),
        ),
        Effect.provide(layer, { local: true }),
      );
    }),
  );

  it.effect(
    "keeps preserved refs and imported transcripts when a transcript write queues behind a locked upsert",
    () =>
      Effect.gen(function* () {
        const upsertEntered = yield* Deferred.make<void>();
        const releaseUpsert = yield* Deferred.make<void>();
        const transcriptEntered = yield* Deferred.make<void>();
        let transcriptCalls = 0;
        const layer = makeProbedDirectoryLayer((real) => ({
          // Seeds are calls one and two; the conditional write below is call
          // three and is the one held at the barrier.
          ...writeProbes({ upsertEntered, releaseUpsert, gateUpsertCall: 3 })(real),
          recordImportedTranscript: (input) =>
            Effect.suspend(() => {
              transcriptCalls++;
              return transcriptCalls === 1
                ? real.recordImportedTranscript(input)
                : Deferred.succeed(transcriptEntered, undefined).pipe(
                    Effect.andThen(real.recordImportedTranscript(input)),
                  );
            }),
        }));

        const fibers: Fiber.Fiber<unknown, unknown>[] = [];
        const claudeSource = {
          ...importedSource,
          provider: "claudeAgent" as const,
          providerInstanceId: ProviderInstanceId.make("claude-current"),
          providerSessionId: claudeSessionA,
          filePath: "/tmp/claude-interleaved-a.jsonl",
        };
        const claudeSourceB = {
          ...claudeSource,
          providerSessionId: claudeSessionB,
          filePath: "/tmp/claude-interleaved-b.jsonl",
        };

        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory;
          const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          const threadId = ThreadId.make("thread-prior-refs-interleaved");
          const identity = claudeIdentity(threadId);

          yield* directory.upsert({
            ...identity,
            runtimePayload: { cwd: "/tmp/interleaved-refs" },
            resumeCursor: claudeCursor(threadId, claudeSessionA),
          });
          yield* directory.upsert({
            ...identity,
            resumeCursor: claudeCursor(threadId, claudeSessionB),
          });
          yield* directory.recordImportedTranscript({ threadId, source: claudeSource });

          // The conditional write holds the thread lock parked inside the
          // repository write; the transcript call queues behind it.
          const conditional = yield* Effect.forkChild(
            directory.upsertIf(
              { ...identity, runtimePayload: { activeTurnId: "turn-x" } },
              () => true,
            ),
          );
          fibers.push(conditional);
          yield* Deferred.await(upsertEntered);
          const transcript = yield* Effect.forkChild(
            directory.recordImportedTranscript({ threadId, source: claudeSourceB }),
          );
          fibers.push(transcript);
          yield* Effect.yieldNow;
          expect(yield* Deferred.isDone(transcriptEntered)).toBe(false);

          yield* Deferred.succeed(releaseUpsert, undefined);
          expect(yield* Fiber.join(conditional)).toBe(true);
          yield* Fiber.join(transcript);

          const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
          expect(runtime.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionB));
          expect(runtime.runtimePayload).toEqual({
            cwd: "/tmp/interleaved-refs",
            activeTurnId: "turn-x",
            [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA)],
            importedTranscripts: [claudeSource, claudeSourceB],
          });
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(releaseUpsert, undefined).pipe(
              Effect.andThen(Fiber.interruptAll(fibers)),
            ),
          ),
          Effect.provide(layer, { local: true }),
        );
      }),
  );

  it.effect("persists preserved refs across a layer restart on the same file database", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(
        NodePath.join(NodeOS.tmpdir(), "t3-provider-ref-persistence-"),
      );
      const dbPath = NodePath.join(tempDir, "orchestration.sqlite");
      // Each provide builds this layer fresh on a local memo map, so the
      // second build is a real restart against the same dbPath.
      const directoryLayer = makeDirectoryLayer(makeSqlitePersistenceLive(dbPath));

      const threadId = ThreadId.make("thread-prior-refs-restart");
      const identity = claudeIdentity(threadId);

      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        yield* directory.upsert({
          ...identity,
          resumeCursor: claudeCursor(threadId, claudeSessionA),
        });
        yield* directory.upsert({
          ...identity,
          resumeCursor: claudeCursor(threadId, claudeSessionB),
        });
      }).pipe(Effect.provide(directoryLayer, { local: true }));

      yield* Effect.gen(function* () {
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        expect(runtime.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionB));
        expect(runtime.runtimePayload).toEqual({
          [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA)],
        });
      }).pipe(Effect.provide(directoryLayer, { local: true }));

      NodeFS.rmSync(tempDir, { recursive: true, force: true });
    }),
  );

  it.effect("keeps stopped bindings in the ownership enumeration with their preserved refs", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const threadId = ThreadId.make("thread-prior-refs-stopped");
      const identity = claudeIdentity(threadId);

      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionA),
      });
      yield* directory.upsert({
        ...identity,
        resumeCursor: claudeCursor(threadId, claudeSessionB),
      });
      yield* directory.upsert({ ...identity, status: "stopped" });

      // Stopped rows stay enumerated (ownership tombstones): dropping them
      // would unblock reimport of their native sessions.
      const stopped = (yield* directory.listBindings()).find(
        (binding) => binding.threadId === threadId,
      );
      if (stopped === undefined) throw new Error("stopped binding missing from listBindings()");
      expect(stopped.runtimePayload).toEqual({
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA)],
      });
      expect(stopped.resumeCursor).toEqual(claudeCursor(threadId, claudeSessionB));

      const live = (yield* directory.listBindings({ excludeStopped: true })).find(
        (binding) => binding.threadId === threadId,
      );
      assert.equal(live, undefined);
    }),
  );

  it.effect("withholds provider lastError on a tainted thread across every write path", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const mark = "A-ECHO2-WRITE-MARK";

      const paths = [
        ["upsert", (binding: Parameters<typeof directory.upsert>[0]) => directory.upsert(binding)],
        [
          "upsertIf",
          (binding: Parameters<typeof directory.upsert>[0]) =>
            directory.upsertIf(binding, () => true),
        ],
        [
          "upsertIfCurrent",
          (binding: Parameters<typeof directory.upsert>[0]) =>
            directory.upsertIfCurrent(binding, () => true),
        ],
      ] as const;
      for (const [name, write] of paths) {
        const threadId = ThreadId.make(`thread-echo-${name}`);
        yield* insertMemorySendAttempt(sql, threadId, `msg-echo-${name}`);
        yield* write({
          ...echoBinding(threadId),
          runtimePayload: { cwd: `/tmp/${name}`, lastError: `${mark} ${name}` },
        });
        const runtime = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        expect(runtime.runtimePayload).toEqual({
          cwd: `/tmp/${name}`,
          lastError: MEMORY_ECHO_WITHHELD_ERROR,
        });
        expect(JSON.stringify(runtime.runtimePayload)).not.toContain(mark);
      }

      // Clean thread contrast: the same shape stores the raw error text.
      const cleanThreadId = ThreadId.make("thread-echo-clean");
      yield* directory.upsert({
        ...echoBinding(cleanThreadId),
        runtimePayload: { cwd: "/tmp/clean", lastError: `${mark} clean` },
      });
      const cleanRuntime = Option.getOrThrow(
        yield* repository.getByThreadId({ threadId: cleanThreadId }),
      );
      expect(cleanRuntime.runtimePayload).toEqual({
        cwd: "/tmp/clean",
        lastError: `${mark} clean`,
      });
    }),
  );

  it.effect("masks the effective merged payload when a stale raw lastError is re-saved", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const mark = "A-ECHO2-MERGED-MARK";
      const threadId = ThreadId.make("thread-echo-merged");
      const binding = echoBinding(threadId);

      yield* seedRuntimeRow(repository, threadId, { cwd: "/tmp/merged", lastError: mark });
      yield* insertMemorySendAttempt(sql, threadId, "msg-echo-merged");

      // An upsert that omits runtimePayload re-saves the stored one: the
      // effective merged row still carries the raw lastError, so it masks.
      yield* directory.upsert({ ...binding, status: "running" });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId })).runtimePayload,
      ).toEqual({ cwd: "/tmp/merged", lastError: MEMORY_ECHO_WITHHELD_ERROR });

      // An unrelated-key patch merges over a re-seeded raw string: other keys
      // survive while only lastError is withheld.
      yield* seedRuntimeRow(repository, threadId, { cwd: "/tmp/merged", lastError: mark });
      yield* directory.upsert({ ...binding, runtimePayload: { activeTurnId: "turn-9" } });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId })).runtimePayload,
      ).toEqual({
        cwd: "/tmp/merged",
        activeTurnId: "turn-9",
        lastError: MEMORY_ECHO_WITHHELD_ERROR,
      });

      // An explicit null clear is preserved: null is stored, not the phrase.
      yield* directory.upsert({ ...binding, runtimePayload: { lastError: null } });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId })).runtimePayload,
      ).toEqual({
        cwd: "/tmp/merged",
        activeTurnId: "turn-9",
        lastError: null,
      });

      // Masking composes with the prior-provider-refs merge: switching away
      // from claude reconstructs the refs metadata while lastError is withheld.
      const refsThread = ThreadId.make("thread-echo-refs");
      yield* repository.upsert({
        threadId: refsThread,
        providerName: "claudeAgent",
        providerInstanceId: ProviderInstanceId.make("claude-current"),
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: MEMORY_ECHO_NOW,
        resumeCursor: claudeCursor(refsThread, claudeSessionA),
        runtimePayload: { cwd: "/tmp/echo-refs", lastError: mark },
      });
      yield* insertMemorySendAttempt(sql, refsThread, "msg-echo-refs");
      yield* directory.upsert({
        ...echoBinding(refsThread),
        runtimePayload: { note: "post-switch" },
      });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId: refsThread })).runtimePayload,
      ).toEqual({
        cwd: "/tmp/echo-refs",
        note: "post-switch",
        lastError: MEMORY_ECHO_WITHHELD_ERROR,
        [PRIOR_PROVIDER_SESSION_IDS_KEY]: [claudeRef(claudeSessionA)],
      });
    }),
  );

  it.effect("masks a malformed non-null lastError conservatively without dropping other keys", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;

      const tainted = ThreadId.make("thread-echo-malformed-tainted");
      yield* insertMemorySendAttempt(sql, tainted, "msg-echo-malformed");
      yield* seedRuntimeRow(repository, tainted, {
        keep: "v",
        lastError: { code: "E_PROVIDER", detail: 42 },
      });
      yield* directory.upsert({ ...echoBinding(tainted), runtimePayload: { patch: true } });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId: tainted })).runtimePayload,
      ).toEqual({ keep: "v", patch: true, lastError: MEMORY_ECHO_WITHHELD_ERROR });

      // Clean contrast: a malformed non-null value is stored untouched — the
      // guard withholds, it does not normalize unknown shapes.
      const clean = ThreadId.make("thread-echo-malformed-clean");
      yield* seedRuntimeRow(repository, clean, {
        keep: "v",
        lastError: { code: "E_PROVIDER", detail: 42 },
      });
      yield* directory.upsert({ ...echoBinding(clean), runtimePayload: { patch: true } });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId: clean })).runtimePayload,
      ).toEqual({ keep: "v", patch: true, lastError: { code: "E_PROVIDER", detail: 42 } });
    }),
  );

  it.effect("withholds lastError when the taint lookup fails and still completes the write", () =>
    Effect.gen(function* () {
      const directory = yield* ProviderSessionDirectory;
      const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
      const sql = yield* SqlClient.SqlClient;
      const mark = "A-ECHO2-DOWN-MARK";
      const tainted = ThreadId.make("thread-echo-down-tainted");
      const clean = ThreadId.make("thread-echo-down-clean");
      yield* insertMemorySendAttempt(sql, tainted, "msg-echo-down");

      yield* sql`ALTER TABLE project_memory_send_attempts RENAME TO broken_send_attempts`;
      // A failed lookup resolves to "unavailable": the write still commits
      // with the lastError withheld on both threads.
      yield* directory.upsert({ ...echoBinding(tainted), runtimePayload: { lastError: mark } });
      yield* directory.upsert({ ...echoBinding(clean), runtimePayload: { lastError: mark } });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId: tainted })).runtimePayload,
      ).toEqual({ lastError: MEMORY_ECHO_WITHHELD_ERROR });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId: clean })).runtimePayload,
      ).toEqual({ lastError: MEMORY_ECHO_WITHHELD_ERROR });

      yield* sql`ALTER TABLE broken_send_attempts RENAME TO project_memory_send_attempts`;
      // The failed lookup was not a durable verdict: once the table is back,
      // the clean thread's raw lastError is stored again.
      yield* directory.upsert({ ...echoBinding(clean), runtimePayload: { lastError: mark } });
      expect(
        Option.getOrThrow(yield* repository.getByThreadId({ threadId: clean })).runtimePayload,
      ).toEqual({ lastError: mark });
    }),
  );

  it.effect("performs no taint lookup for skipped writes or payloads without lastError", () =>
    Effect.gen(function* () {
      const probe: MemoryEchoLookupProbe = { lookups: 0, armedCause: null };
      const layer = makeLookupProbedDirectoryLayer(probe);
      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-echo-no-lookup");
        const binding = echoBinding(threadId);
        yield* insertMemorySendAttempt(sql, threadId, "msg-echo-no-lookup");

        // A merged payload with no non-null lastError never reads the ledger.
        yield* directory.upsert({
          ...binding,
          runtimePayload: { cwd: "/tmp/nolookup", lastError: null },
        });
        yield* directory.upsert({ ...binding, status: "stopped" });
        assert.strictEqual(probe.lookups, 0);

        // A false upsertIf evaluates only its predicate: no lookup and no
        // row change, even though its payload carries lastError.
        // upsertIfCurrent still performs its one locked current-row read
        // before the false predicate — no taint lookup and no write.
        expect(
          yield* directory.upsertIf(
            { ...binding, status: "error", runtimePayload: { lastError: "sneak" } },
            () => false,
          ),
        ).toBe(false);
        expect(
          yield* directory.upsertIfCurrent(
            { ...binding, status: "error", runtimePayload: { lastError: "sneak" } },
            () => false,
          ),
        ).toBe(false);
        assert.strictEqual(probe.lookups, 0);
        expect(
          Option.getOrThrow(yield* repository.getByThreadId({ threadId })).runtimePayload,
        ).toEqual({ cwd: "/tmp/nolookup", lastError: null });

        // Control: a real lastError write on the same thread hits the lookup.
        yield* directory.upsert({ ...binding, runtimePayload: { lastError: "mark" } });
        assert.strictEqual(probe.lookups, 1);
      }).pipe(Effect.provide(layer, { local: true }));
    }),
  );

  it.effect("propagates the repository write failure instead of masking it as success", () =>
    Effect.gen(function* () {
      const layer = makeProbedDirectoryLayer(() => ({
        upsert: () =>
          Effect.fail(
            new PersistenceSqlError({
              operation: "ProviderSessionRuntimeRepository.upsert:query",
              detail: "injected write failure",
            }),
          ),
      }));
      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const sql = yield* SqlClient.SqlClient;
        const threadId = ThreadId.make("thread-echo-write-fails");
        yield* insertMemorySendAttempt(sql, threadId, "msg-echo-write-fails");

        const outcome = yield* Effect.result(
          directory.upsert({
            ...echoBinding(threadId),
            runtimePayload: { lastError: "A-ECHO2-WRITE-FAIL" },
          }),
        );
        assert.strictEqual(outcome._tag, "Failure");
        if (outcome._tag === "Failure") {
          assert.strictEqual(outcome.failure._tag, "ProviderSessionDirectoryPersistenceError");
        }
        assert.ok(Option.isNone(yield* repository.getByThreadId({ threadId })));
      }).pipe(Effect.provide(layer, { local: true }));
    }),
  );

  it.effect("propagates an interrupt-bearing lookup cause verbatim and masks on a defect", () =>
    Effect.gen(function* () {
      const probe: MemoryEchoLookupProbe = { lookups: 0, armedCause: null };
      const layer = makeLookupProbedDirectoryLayer(probe);
      yield* Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const sql = yield* SqlClient.SqlClient;
        const injected = new SqlError({
          reason: classifySqliteError(new Error("injected lookup failure"), {
            message: "injected lookup failure",
            operation: "execute",
          }),
        });
        probe.armedCause = Cause.combine(Cause.fail(injected), Cause.interrupt());

        const tainted = ThreadId.make("thread-echo-mixed-cause");
        yield* insertMemorySendAttempt(sql, tainted, "msg-echo-mixed-cause");
        const exit = yield* Effect.exit(
          directory.upsert({ ...echoBinding(tainted), runtimePayload: { lastError: "mark" } }),
        );
        assert.ok(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          // The original cause comes back: the interrupt is present and the
          // typed component is still inside it.
          assert.ok(Cause.hasInterrupts(exit.cause));
          assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(injected));
        }
        // The aborted write reached no repository: no row was stored.
        assert.ok(Option.isNone(yield* repository.getByThreadId({ threadId: tainted })));

        // A defect without interrupts resolves to "unavailable" inside the
        // helper: the write still commits with lastError withheld.
        const defectThread = ThreadId.make("thread-echo-defect");
        yield* insertMemorySendAttempt(sql, defectThread, "msg-echo-defect");
        probe.armedCause = Cause.die(new Error("lookup defect"));
        yield* directory.upsert({
          ...echoBinding(defectThread),
          runtimePayload: { lastError: "A-ECHO2-DEFECT-MARK" },
        });
        probe.armedCause = null;
        expect(
          Option.getOrThrow(yield* repository.getByThreadId({ threadId: defectThread }))
            .runtimePayload,
        ).toEqual({ lastError: MEMORY_ECHO_WITHHELD_ERROR });
      }).pipe(Effect.provide(layer, { local: true }));
    }),
  );
});

// The fence hooks are optional on the shape; the live layer always
// implements both. These helpers fail loudly on absence instead of letting
// an undefined return slip through an assertion.
const captureWriteFence = (
  directory: ProviderSessionDirectory["Service"],
  threadId: ThreadId,
): ProviderSessionWriteFence => {
  const capture = directory.captureWriteFence;
  if (capture === undefined) {
    throw new Error("live directory must implement captureWriteFence");
  }
  return capture(threadId);
};

const writeFenceHolds = (
  directory: ProviderSessionDirectory["Service"],
  fence: ProviderSessionWriteFence,
): boolean => {
  const holds = directory.writeFenceHolds;
  if (holds === undefined) {
    throw new Error("live directory must implement writeFenceHolds");
  }
  return holds(fence);
};

const fenceBinding = (threadId: ThreadId) =>
  ({
    threadId,
    provider: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
  }) as const;

it.layer(makeDirectoryLayer(SqlitePersistenceMemory))(
  "ProviderSessionDirectoryLive write fence",
  (it) => {
    it.effect("D1: a captured fence holds while the thread sees no write", () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const threadId = ThreadId.make("thread-fence-d1");

        const fence = captureWriteFence(directory, threadId);
        expect(writeFenceHolds(directory, fence)).toBe(true);

        // Reads never take the write lock and must not disturb the fence.
        expect(Option.isNone(yield* directory.getBinding(threadId))).toBe(true);
        expect(writeFenceHolds(directory, fence)).toBe(true);

        // A completed write ends it; the next capture starts strictly ahead.
        yield* directory.upsert({ ...fenceBinding(threadId), runtimePayload: { v: 1 } });
        expect(writeFenceHolds(directory, fence)).toBe(false);
        const next = captureWriteFence(directory, threadId);
        expect(next.seq).toBeGreaterThan(fence.seq);
        expect(writeFenceHolds(directory, next)).toBe(true);
      }),
    );

    it.effect("D2: a same-value rewrite and no-op conditional writes break the fence", () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        const threadId = ThreadId.make("thread-fence-d2");
        const binding = {
          ...fenceBinding(threadId),
          status: "running" as const,
          resumeCursor: { threadId: "fence-d2-cursor" },
          runtimePayload: { cwd: "/tmp/fence-d2" },
        };

        yield* directory.upsert(binding);
        const before = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        const fence = captureWriteFence(directory, threadId);

        // ABA: the rewrite stores the same row (lastSeenAt aside) yet still
        // bumped the sequence — the fence tracks writes, not values.
        yield* directory.upsert(binding);
        const after = Option.getOrThrow(yield* repository.getByThreadId({ threadId }));
        expect({ ...after, lastSeenAt: before.lastSeenAt }).toEqual(before);
        expect(writeFenceHolds(directory, fence)).toBe(false);

        // An acquired lock that wrote nothing still bumps conservatively:
        // a refused upsertIf predicate runs no repository read or write…
        const refusedPredicateFence = captureWriteFence(directory, threadId);
        expect(yield* directory.upsertIf({ ...binding, status: "stopped" }, () => false)).toBe(
          false,
        );
        expect(writeFenceHolds(directory, refusedPredicateFence)).toBe(false);

        // …and a refused upsertIfCurrent predicate, which did hold the lock
        // and read the current row before declining.
        const readOnlyFence = captureWriteFence(directory, threadId);
        expect(
          yield* directory.upsertIfCurrent({ ...binding, status: "stopped" }, () => false),
        ).toBe(false);
        expect(writeFenceHolds(directory, readOnlyFence)).toBe(false);
      }),
    );

    it.effect("D3: a write on another thread leaves the fence intact", () =>
      Effect.gen(function* () {
        const directory = yield* ProviderSessionDirectory;
        const watched = ThreadId.make("thread-fence-d3-watched");
        const other = ThreadId.make("thread-fence-d3-other");

        yield* directory.upsert(fenceBinding(watched));
        const fence = captureWriteFence(directory, watched);

        yield* directory.upsert({ ...fenceBinding(other), runtimePayload: { other: true } });
        // The other write really committed; the watched thread's fence is
        // untouched because tracking is per thread.
        expect(Option.isSome(yield* directory.getBinding(other))).toBe(true);
        expect(writeFenceHolds(directory, fence)).toBe(true);
      }),
    );

    it.effect("D4: an in-flight write breaks the fence before it commits", () =>
      Effect.gen(function* () {
        const upsertEntered = yield* Deferred.make<void>();
        const releaseUpsert = yield* Deferred.make<void>();
        const layer = makeProbedDirectoryLayer(writeProbes({ upsertEntered, releaseUpsert }));
        const fibers: Fiber.Fiber<unknown, unknown>[] = [];

        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory;
          const threadId = ThreadId.make("thread-fence-d4");
          const fence = captureWriteFence(directory, threadId);
          expect(writeFenceHolds(directory, fence)).toBe(true);

          const writer = yield* Effect.forkChild(directory.upsert(fenceBinding(threadId)));
          fibers.push(writer);
          // Parked inside the repository write while holding the lock.
          yield* Deferred.await(upsertEntered);

          // The write has not committed, yet the fence already fails: an
          // in-flight writer is indistinguishable from a committed one.
          expect(writeFenceHolds(directory, fence)).toBe(false);

          yield* Deferred.succeed(releaseUpsert, undefined);
          yield* Fiber.join(writer);
          expect(writeFenceHolds(directory, fence)).toBe(false);
          const after = captureWriteFence(directory, threadId);
          expect(writeFenceHolds(directory, after)).toBe(true);
        }).pipe(
          // Release a parked writer, then drain every spawned fiber — inside
          // the provided region so the local layer's scope closes only after
          // writers finish. interruptAll is a no-op on exited fibers.
          Effect.ensuring(
            Deferred.succeed(releaseUpsert, undefined).pipe(
              Effect.andThen(Fiber.interruptAll(fibers)),
            ),
          ),
          Effect.provide(layer, { local: true }),
        );
      }),
    );

    it.effect("D5: a failed write bumps the fence and keeps its cause", () =>
      Effect.gen(function* () {
        const injected = new PersistenceSqlError({
          operation: "ProviderSessionRuntimeRepository.upsert:query",
          detail: "injected write failure",
        });
        const failingLayer = makeProbedDirectoryLayer(() => ({
          upsert: () => Effect.fail(injected),
        }));
        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory;
          const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          const threadId = ThreadId.make("thread-fence-d5-fail");
          const fence = captureWriteFence(directory, threadId);

          const exit = yield* Effect.exit(directory.upsert(fenceBinding(threadId)));
          assert.ok(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            const error = Cause.findErrorOption(exit.cause);
            assert.ok(
              Option.isSome(error) &&
                error.value._tag === "ProviderSessionDirectoryPersistenceError",
            );
            if (
              Option.isSome(error) &&
              error.value._tag === "ProviderSessionDirectoryPersistenceError"
            ) {
              // The original typed SqlError survives verbatim inside the
              // directory persistence error's cause field.
              assert.strictEqual(error.value.cause, injected);
            }
          }
          // Nothing committed, yet the failed writer conservatively bumped.
          expect(Option.isNone(yield* repository.getByThreadId({ threadId }))).toBe(true);
          expect(writeFenceHolds(directory, fence)).toBe(false);
          expect(writeFenceHolds(directory, captureWriteFence(directory, threadId))).toBe(true);
        }).pipe(Effect.provide(failingLayer, { local: true }));

        // An interrupt-bearing cause crosses the new fence wrapper
        // unchanged: the memory-echo lookup is the one write path whose
        // typed SqlError is not re-mapped, so it is the honest witness for
        // mixed-cause preservation.
        const probe: MemoryEchoLookupProbe = { lookups: 0, armedCause: null };
        const lookupLayer = makeLookupProbedDirectoryLayer(probe);
        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory;
          const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
          const sql = yield* SqlClient.SqlClient;
          const injectedLookup = new SqlError({
            reason: classifySqliteError(new Error("injected lookup failure"), {
              message: "injected lookup failure",
              operation: "execute",
            }),
          });
          probe.armedCause = Cause.combine(Cause.fail(injectedLookup), Cause.interrupt());

          const threadId = ThreadId.make("thread-fence-d5-mixed");
          yield* insertMemorySendAttempt(sql, threadId, "msg-fence-d5-mixed");
          const fence = captureWriteFence(directory, threadId);

          const exit = yield* Effect.exit(
            directory.upsert({ ...echoBinding(threadId), runtimePayload: { lastError: "mark" } }),
          );
          assert.ok(Exit.isFailure(exit));
          if (Exit.isFailure(exit)) {
            assert.ok(Cause.hasInterrupts(exit.cause));
            assert.deepEqual(Cause.findErrorOption(exit.cause), Option.some(injectedLookup));
          }
          assert.strictEqual(probe.lookups, 1);
          probe.armedCause = null;
          expect(writeFenceHolds(directory, fence)).toBe(false);
          expect(Option.isNone(yield* repository.getByThreadId({ threadId }))).toBe(true);
        }).pipe(Effect.provide(lookupLayer, { local: true }));
      }),
    );

    it.effect("D6: a writer interrupted on the permit leaves the fence intact", () =>
      Effect.gen(function* () {
        const upsertEntered = yield* Deferred.make<void>();
        const releaseUpsert = yield* Deferred.make<void>();
        const readerEntered = yield* Deferred.make<void>();
        const layer = makeProbedDirectoryLayer(
          writeProbes({ upsertEntered, releaseUpsert, readerEntered }),
        );
        const fibers: Fiber.Fiber<unknown, unknown>[] = [];

        yield* Effect.gen(function* () {
          const directory = yield* ProviderSessionDirectory;
          const threadId = ThreadId.make("thread-fence-d6");
          const binding = fenceBinding(threadId);

          const before = captureWriteFence(directory, threadId);
          const holder = yield* Effect.forkChild(
            directory.upsert({ ...binding, runtimePayload: { holder: true } }),
          );
          fibers.push(holder);
          yield* Deferred.await(upsertEntered);

          const waiter = yield* Effect.forkChild(
            directory.upsert({ ...binding, status: "error", runtimePayload: { waiter: true } }),
          );
          fibers.push(waiter);
          yield* Effect.yieldNow;
          // Still queued on the permit: its locked read never ran.
          expect(yield* Deferred.isDone(readerEntered)).toBe(false);

          yield* Fiber.interrupt(waiter);
          const waiterExit = yield* Fiber.await(waiter);
          assert.ok(Exit.isFailure(waiterExit));
          if (Exit.isFailure(waiterExit)) {
            assert.ok(Cause.hasInterrupts(waiterExit.cause));
          }

          // The interrupted wait produced no write and no bump: the global
          // sequence is exactly where the pre-capture left it. A fence can
          // only prove this through the sequence number — while the holder
          // is parked, `writeFenceHolds` already reads broken on its own
          // in-flight write.
          const afterInterrupt = captureWriteFence(directory, threadId);
          expect(afterInterrupt.seq).toBe(before.seq);

          yield* Deferred.succeed(releaseUpsert, undefined);
          yield* Fiber.join(holder);
          // Exactly one bump happened in the whole sequence — the holder's
          // commit — and a fence captured now holds.
          const after = captureWriteFence(directory, threadId);
          expect(after.seq).toBe(before.seq + 1);
          expect(writeFenceHolds(directory, after)).toBe(true);
          expect(writeFenceHolds(directory, before)).toBe(false);
        }).pipe(
          Effect.ensuring(
            Deferred.succeed(releaseUpsert, undefined).pipe(
              Effect.andThen(Fiber.interruptAll(fibers)),
            ),
          ),
          Effect.provide(layer, { local: true }),
        );
      }),
    );
  },
);
