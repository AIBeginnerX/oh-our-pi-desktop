import { defaultInstanceIdForDriver, ProviderDriverKind, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  MEMORY_ECHO_WITHHELD_ERROR,
  lookupMemoryEchoThreadState,
  memoryEchoThreadShouldWithhold,
} from "../../orchestration/memoryEcho.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderSessionDirectoryPersistenceError, ProviderValidationError } from "../Errors.ts";
import {
  PRIOR_PROVIDER_SESSION_IDS_KEY,
  preservePriorProviderSessionRefs,
} from "../providerSessionIds.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
  type ProviderRuntimeBindingWithMetadata,
  type ProviderSessionDirectoryShape,
  type ProviderSessionDirectoryUpsertOptions,
  type ProviderSessionWriteFence,
} from "../Services/ProviderSessionDirectory.ts";
const decodeProviderDriverKindValue = Schema.decodeUnknownEffect(ProviderDriverKind);

function toPersistenceError(operation: string) {
  return (cause: unknown) =>
    new ProviderSessionDirectoryPersistenceError({
      operation,
      detail: `Failed to execute ${operation}.`,
      cause,
    });
}

function decodeProviderDriverKind(
  providerName: string,
  operation: string,
): Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderDriverKindValue(providerName).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderSessionDirectoryPersistenceError({
          operation,
          detail: `Unknown persisted provider '${providerName}'.`,
          cause,
        }),
    ),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeRuntimePayload(
  existing: unknown | null,
  next: unknown | null | undefined,
): unknown | null {
  if (next === undefined) {
    return existing ?? null;
  }
  if (isRecord(existing) && isRecord(next)) {
    return { ...existing, ...next };
  }
  return next;
}

function toRuntimeBinding(
  runtime: ProviderSessionRuntime.ProviderSessionRuntime,
  operation: string,
): Effect.Effect<ProviderRuntimeBindingWithMetadata, ProviderSessionDirectoryPersistenceError> {
  return decodeProviderDriverKind(runtime.providerName, operation).pipe(
    Effect.map(
      (provider) =>
        ({
          threadId: runtime.threadId,
          provider,
          // Migration boundary only: rows written before the instance split
          // have a null provider_instance_id. Promote them as they leave
          // persistence so hot routing code never has to infer an instance
          // from a driver kind.
          providerInstanceId: runtime.providerInstanceId ?? defaultInstanceIdForDriver(provider),
          adapterKey: runtime.adapterKey,
          runtimeMode: runtime.runtimeMode,
          status: runtime.status,
          resumeCursor: runtime.resumeCursor,
          runtimePayload: runtime.runtimePayload,
          lastSeenAt: runtime.lastSeenAt,
        }) satisfies ProviderRuntimeBindingWithMetadata,
    ),
  );
}

const makeProviderSessionDirectory = Effect.gen(function* () {
  const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const sql = yield* SqlClient.SqlClient;

  // Per-thread write serialization, shared by upsert/upsertIf/
  // recordImportedTranscript and owned by this layer instance. Refcounted
  // like the workspace lease so idle locks are dropped; different threads
  // never wait on each other's lock.
  const writeLocks = new Map<string, { semaphore: Semaphore.Semaphore; users: number }>();

  // Write-fence counters, owned by the same layer instance as the locks.
  // `writeSeq` only ever increases; `lastWrite` keeps each thread's last
  // completed locked write forever — dropping an entry when its lock's
  // refcount hits zero would make a fence captured before the drop look
  // fresh again (ABA). `writing` holds only writers currently inside the
  // permit-guarded region.
  let writeSeq = 0;
  const lastWrite = new Map<ThreadId, number>();
  const writing = new Map<ThreadId, number>();

  const withWriteLock = <A, E>(
    operation: string,
    threadId: ThreadId,
    effect: Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.flatMap(Effect.serviceOption(sql.transactionService), (active) =>
      // The directory serializes its own read-merge-write. Inside a caller's
      // transaction its writes would savepoint-commit — silently revocable by
      // an outer rollback — and the lock could invert against engine
      // transactions, so nesting is a programming fault.
      Option.isSome(active)
        ? Effect.die(new Error(`${operation} must not run inside sql.withTransaction`))
        : Effect.suspend(() => {
            const lock = writeLocks.get(threadId) ?? {
              semaphore: Semaphore.makeUnsafe(1),
              users: 0,
            };
            writeLocks.set(threadId, lock);
            lock.users++;
            // The permit wait stays interruptible while the protected
            // predicate-through-write body is not; the semaphore releases on
            // every exit and the refcount drops on every exit including an
            // interrupted wait. Only a writer that owns the permit enters
            // the tracked region, so a queued or interrupted waiter cannot
            // disturb a captured fence; every settled exit bumps the seq —
            // false predicates and failed writes included — and the
            // synchronous release leaves the body's own exit, cause intact,
            // as the result.
            return lock.semaphore
              .withPermit(
                Effect.uninterruptible(
                  Effect.acquireUseRelease(
                    Effect.sync(() => {
                      writing.set(threadId, (writing.get(threadId) ?? 0) + 1);
                    }),
                    () => effect,
                    () =>
                      Effect.sync(() => {
                        lastWrite.set(threadId, ++writeSeq);
                        const remaining = (writing.get(threadId) ?? 0) - 1;
                        if (remaining <= 0) {
                          writing.delete(threadId);
                        } else {
                          writing.set(threadId, remaining);
                        }
                      }),
                  ),
                ),
              )
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    lock.users--;
                    if (lock.users === 0) writeLocks.delete(threadId);
                  }),
                ),
              );
          }),
    );

  const getBinding = (threadId: ThreadId) =>
    repository.getByThreadId({ threadId }).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.getBinding:getByThreadId")),
      Effect.flatMap((runtime) =>
        Option.match(runtime, {
          onNone: () => Effect.succeed(Option.none<ProviderRuntimeBinding>()),
          onSome: (value) =>
            toRuntimeBinding(value, "ProviderSessionDirectory.getBinding").pipe(Effect.asSome),
        }),
      ),
    );

  // The unlocked read-merge-write. Only runs under withWriteLock, so
  // conditional writes never re-enter the public locking methods.
  const upsertRow = Effect.fnUntraced(function* (
    binding: ProviderRuntimeBinding,
    options?: ProviderSessionDirectoryUpsertOptions,
  ) {
    const existing = yield* repository
      .getByThreadId({ threadId: binding.threadId })
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:getByThreadId")));

    const existingRuntime = Option.getOrUndefined(existing);
    const resolvedThreadId = binding.threadId ?? existingRuntime?.threadId;
    if (!resolvedThreadId) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "threadId must be a non-empty string.",
      });
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const providerChanged =
      existingRuntime !== undefined && existingRuntime.providerName !== binding.provider;
    const providerInstanceId =
      binding.providerInstanceId ?? (!providerChanged ? existingRuntime?.providerInstanceId : null);
    if (providerInstanceId === null || providerInstanceId === undefined) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: "providerInstanceId is required for provider session runtime bindings.",
      });
    }
    const resumeCursor =
      binding.resumeCursor !== undefined
        ? binding.resumeCursor
        : (existingRuntime?.resumeCursor ?? null);
    const mergedRuntimePayload = mergeRuntimePayload(
      existingRuntime?.runtimePayload ?? null,
      binding.runtimePayload,
    );
    const preservedRefs = preservePriorProviderSessionRefs({
      // The old cursor is interpreted under the old row's provider/instance;
      // the effective next cursor below under the identity being stored.
      existing: {
        providerName: existingRuntime?.providerName ?? binding.provider,
        providerInstanceId: existingRuntime?.providerInstanceId ?? null,
        resumeCursor: existingRuntime?.resumeCursor ?? null,
        runtimePayload: existingRuntime?.runtimePayload ?? null,
      },
      next: {
        providerName: binding.provider,
        providerInstanceId,
        resumeCursor,
      },
      mergedRuntimePayload,
    });
    if (!Result.isSuccess(preservedRefs)) {
      return yield* new ProviderValidationError({
        operation: "ProviderSessionDirectory.upsert",
        issue: `'${PRIOR_PROVIDER_SESSION_IDS_KEY}' runtime payload metadata is malformed.`,
        cause: preservedRefs.failure,
      });
    }
    // Refs are reconstructed explicitly rather than left to the shallow
    // payload merge: an explicit null or stale payload must not erase them.
    let runtimePayload =
      preservedRefs.success.length > 0
        ? {
            ...(isRecord(mergedRuntimePayload) ? mergedRuntimePayload : {}),
            [PRIOR_PROVIDER_SESSION_IDS_KEY]: preservedRefs.success,
          }
        : mergedRuntimePayload;
    if (isRecord(runtimePayload) && runtimePayload.lastError != null) {
      // The memory-echo verdict judges the effective merged payload, so a
      // stale stored lastError re-saved by an undefined or unrelated patch is
      // masked too. Any non-null value is withheld; an explicit null stays a
      // clear and skips the lookup. Ordinary lookup failures resolve to
      // "unavailable" inside the helper and still mask; an interrupt-bearing
      // cause propagates unchanged with its typed SqlError component.
      const threadState = yield* lookupMemoryEchoThreadState(sql, resolvedThreadId);
      if (memoryEchoThreadShouldWithhold(threadState)) {
        runtimePayload = { ...runtimePayload, lastError: MEMORY_ECHO_WITHHELD_ERROR };
      }
    }
    yield* repository
      .upsert(
        {
          threadId: resolvedThreadId,
          providerName: binding.provider,
          providerInstanceId,
          adapterKey:
            binding.adapterKey ??
            (providerChanged
              ? binding.provider
              : (existingRuntime?.adapterKey ?? binding.provider)),
          runtimeMode: binding.runtimeMode ?? existingRuntime?.runtimeMode ?? "full-access",
          status: binding.status ?? existingRuntime?.status ?? "running",
          lastSeenAt: now,
          resumeCursor,
          runtimePayload,
        },
        options,
      )
      .pipe(Effect.mapError(toPersistenceError("ProviderSessionDirectory.upsert:upsert")));
  });

  const upsert: ProviderSessionDirectoryShape["upsert"] = (binding, options) =>
    withWriteLock("ProviderSessionDirectory.upsert", binding.threadId, upsertRow(binding, options));

  const upsertIf: ProviderSessionDirectoryShape["upsertIf"] = (binding, when) =>
    withWriteLock(
      "ProviderSessionDirectory.upsertIf",
      binding.threadId,
      Effect.suspend(() =>
        when() ? upsertRow(binding).pipe(Effect.as(true)) : Effect.succeed(false),
      ),
    );

  // Unlike upsertIf, judging the current row requires reading it: a false
  // predicate performs that one locked read and no write. getBinding never
  // takes the lock, so the read does not re-enter the public locking methods.
  const upsertIfCurrent: ProviderSessionDirectoryShape["upsertIfCurrent"] = (binding, when) =>
    withWriteLock(
      "ProviderSessionDirectory.upsertIfCurrent",
      binding.threadId,
      Effect.flatMap(getBinding(binding.threadId), (current) =>
        when(current) ? upsertRow(binding).pipe(Effect.as(true)) : Effect.succeed(false),
      ),
    );

  const getProvider: ProviderSessionDirectoryShape["getProvider"] = (threadId) =>
    getBinding(threadId).pipe(
      Effect.flatMap((binding) =>
        Option.match(binding, {
          onSome: (value) => Effect.succeed(value.provider),
          onNone: () =>
            Effect.fail(
              new ProviderSessionDirectoryPersistenceError({
                operation: "ProviderSessionDirectory.getProvider",
                detail: `No persisted provider binding found for thread '${threadId}'.`,
              }),
            ),
        }),
      ),
    );

  const recordImportedTranscript: ProviderSessionDirectoryShape["recordImportedTranscript"] = (
    input,
  ) =>
    withWriteLock(
      "ProviderSessionDirectory.recordImportedTranscript",
      input.threadId,
      repository
        .recordImportedTranscript(input)
        .pipe(
          Effect.mapError(toPersistenceError("ProviderSessionDirectory.recordImportedTranscript")),
        ),
    );

  const listThreadIds: ProviderSessionDirectoryShape["listThreadIds"] = () =>
    repository.list().pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listThreadIds:list")),
      Effect.map((rows) => rows.map((row) => row.threadId)),
    );

  const listBindings: ProviderSessionDirectoryShape["listBindings"] = (options) =>
    repository.list(options).pipe(
      Effect.mapError(toPersistenceError("ProviderSessionDirectory.listBindings:list")),
      Effect.flatMap((rows) =>
        Effect.forEach(
          rows,
          (row) => toRuntimeBinding(row, "ProviderSessionDirectory.listBindings"),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const captureWriteFence = (threadId: ThreadId): ProviderSessionWriteFence => ({
    threadId,
    seq: writeSeq,
  });

  const writeFenceHolds = (fence: ProviderSessionWriteFence): boolean =>
    (writing.get(fence.threadId) ?? 0) === 0 && (lastWrite.get(fence.threadId) ?? 0) <= fence.seq;

  return {
    upsert,
    upsertIf,
    upsertIfCurrent,
    recordImportedTranscript,
    getProvider,
    getBinding,
    listThreadIds,
    listBindings,
    captureWriteFence,
    writeFenceHolds,
  } satisfies ProviderSessionDirectoryShape;
});

export const ProviderSessionDirectoryLive = Layer.effect(
  ProviderSessionDirectory,
  makeProviderSessionDirectory,
);
