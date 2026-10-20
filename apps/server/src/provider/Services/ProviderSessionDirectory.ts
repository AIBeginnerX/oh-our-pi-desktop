import type {
  AgentSessionImportSource,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/unstable/sql/SqlError";

import type {
  ProviderSessionDirectoryPersistenceError,
  ProviderValidationError,
} from "../Errors.ts";

export interface ProviderRuntimeBinding {
  readonly threadId: ThreadId;
  readonly provider: ProviderDriverKind;
  /**
   * Routing key for the configured provider instance that owns this
   * session. The persistence layer promotes legacy null rows before
   * exposing bindings; runtime callers must not infer this from `provider`.
   */
  readonly providerInstanceId?: ProviderInstanceId;
  readonly adapterKey?: string;
  readonly status?: ProviderSessionRuntimeStatus;
  readonly resumeCursor?: unknown | null;
  readonly runtimePayload?: unknown | null;
  readonly runtimeMode?: RuntimeMode;
}

export interface ProviderRuntimeBindingWithMetadata extends ProviderRuntimeBinding {
  readonly lastSeenAt: string;
}

export type ProviderSessionDirectoryReadError = ProviderSessionDirectoryPersistenceError;

export type ProviderSessionDirectoryWriteError =
  | ProviderValidationError
  | ProviderSessionDirectoryPersistenceError
  // The memory-echo ledger lookup fails typed SqlError; its
  // interrupt-bearing causes carry that SqlError through verbatim.
  | SqlError;

export interface ProviderSessionDirectoryUpsertOptions {
  readonly onConflict?: "update" | "ignore";
}

/**
 * A synchronous point-in-time claim over one thread's directory write
 * stream, produced inside the same process that serves the directory.
 * `seq` is the instance-wide write sequence observed at capture time; it is
 * meaningful only against the counters of the directory instance that
 * produced it.
 */
export interface ProviderSessionWriteFence {
  readonly threadId: ThreadId;
  readonly seq: number;
}

export interface ProviderSessionDirectoryShape {
  readonly upsert: (
    binding: ProviderRuntimeBinding,
    options?: ProviderSessionDirectoryUpsertOptions,
  ) => Effect.Effect<void, ProviderSessionDirectoryWriteError>;

  /**
   * Conditional `upsert`. `when` is a synchronous predicate evaluated inside
   * the thread's write lock, before the read-merge-write runs. A false
   * predicate performs no repository read or write and resolves `false`; a
   * `true` result means the merged write completed.
   */
  readonly upsertIf: (
    binding: ProviderRuntimeBinding,
    when: () => boolean,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryWriteError>;

  /**
   * Conditional patch: `when` sees the current decoded row inside the
   * thread's write lock. A false predicate writes nothing and resolves
   * `false`; `true` means the merged write completed.
   */
  readonly upsertIfCurrent: (
    binding: ProviderRuntimeBinding,
    when: (current: Option.Option<ProviderRuntimeBinding>) => boolean,
  ) => Effect.Effect<boolean, ProviderSessionDirectoryWriteError>;

  /** Record an imported file without changing the current provider session. */
  readonly recordImportedTranscript: (input: {
    readonly threadId: ThreadId;
    readonly source: AgentSessionImportSource;
  }) => Effect.Effect<void, ProviderSessionDirectoryPersistenceError>;

  readonly getProvider: (
    threadId: ThreadId,
  ) => Effect.Effect<ProviderDriverKind, ProviderSessionDirectoryReadError>;

  readonly getBinding: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<ProviderRuntimeBinding>, ProviderSessionDirectoryReadError>;

  readonly listThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProviderSessionDirectoryPersistenceError
  >;

  /** `excludeStopped` skips stopped rows in the query, not after decoding. */
  readonly listBindings: (options?: {
    readonly excludeStopped?: boolean;
  }) => Effect.Effect<
    ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
    ProviderSessionDirectoryPersistenceError
  >;

  /**
   * Captures the current write position for `threadId` so a later
   * synchronous check can tell whether the thread's binding may have
   * changed since. Used by the memory-send admission path; callers must
   * tolerate its absence because directories without it refuse the
   * handoff instead of racing.
   */
  readonly captureWriteFence?: (threadId: ThreadId) => ProviderSessionWriteFence;

  /**
   * `false` when a writer on `fence.threadId` holds the write lock now or
   * completed a locked write after `fence` was captured — same-value
   * rewrites, no-op conditional calls and failed writes included. Writes
   * on other threads and writers still queued on the permit do not break
   * it. Purely synchronous: it reads only this instance's counters.
   */
  readonly writeFenceHolds?: (fence: ProviderSessionWriteFence) => boolean;
}

export class ProviderSessionDirectory extends Context.Service<
  ProviderSessionDirectory,
  ProviderSessionDirectoryShape
>()("t3/provider/Services/ProviderSessionDirectory") {}
