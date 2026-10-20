/**
 * ProviderEventLoggers — single observability service that owns the shared
 * provider event log store and exposes its two runtime views:
 *
 *   - `native`    — provider-protocol events as the SDK emits them, written
 *                   from inside each `<X>Adapter` factory.
 *   - `canonical` — runtime events after `ProviderService` has normalized
 *                   them onto `ProviderRuntimeEvent`.
 *
 * Why a service tag and not constructor options?
 *
 *   - Adapters are now constructed *inside* drivers (`<X>Driver.create()`),
 *     not at the boot Layer. There is no longer a single `make<X>AdapterLive(options)`
 *     call site where we can hand an `EventNdjsonLogger` in by hand.
 *   - Multiple driver instances per kind (`codex_personal`, `codex_work`)
 *     must share one underlying log store — opening N writers against the
 *     same rotating file would race the rotation logic. Owning the loggers on
 *     a single tag keeps that invariant intact.
 *   - Tests can swap one (or both) loggers with in-memory recorders by
 *     `Layer.succeed(ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional because observability must not prevent startup.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ThreadId } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import * as EventNdjsonLogger from "./EventNdjsonLogger.ts";

/**
 * Shared logger pair for native + canonical provider event streams.
 *
 * Service value is intentionally a struct of two optional loggers rather
 * than two parallel tags. Construction site is one place
 * (`layer`); consumers (drivers, `ProviderService`) read one tag and pluck the
 * field they need.
 */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  {
    readonly native: EventNdjsonLogger.EventNdjsonLogger | undefined;
    readonly canonical: EventNdjsonLogger.EventNdjsonLogger | undefined;
  }
>()("t3/provider/Layers/ProviderEventLoggers") {}

/**
 * Constant value used by tests / boot layers that want to opt out of native
 * + canonical logging entirely. Keeps the tag non-optional in the type
 * system while letting the runtime treat absence as a no-op.
 */
export const NoOpProviderEventLoggers: ProviderEventLoggers["Service"] = {
  native: undefined,
  canonical: undefined,
};

/**
 * Restricted taint lookups stay below SQLite's bound-variable ceiling. The
 * store may hand a detached batch larger than its admission window, so the
 * bound is enforced here too; every chunk must succeed before positives merge
 * because a partial read must never be treated as clean.
 */
const TAINTED_THREADS_CHUNK_SIZE = 500;

// `thread_id` decodes at runtime instead of being trusted: a malformed row is
// a lookup failure that closes the affected batch, never an accepted id.
const decodeTaintedThreadRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: ThreadId })),
);

const lookupTaintedThreads = (
  sql: SqlClient.SqlClient,
  threadIds: ReadonlyArray<ThreadId> | undefined,
): Effect.Effect<ReadonlySet<ThreadId>, unknown> =>
  Effect.forEach(
    threadIds === undefined
      ? [sql`SELECT DISTINCT thread_id AS "threadId" FROM project_memory_send_attempts`]
      : Arr.chunksOf(threadIds, TAINTED_THREADS_CHUNK_SIZE).map(
          (chunk) => sql`
            SELECT DISTINCT thread_id AS "threadId" FROM project_memory_send_attempts
            WHERE ${sql.in("thread_id", chunk)}
          `,
        ),
    (statement) => statement.pipe(Effect.flatMap(decodeTaintedThreadRows)),
  ).pipe(
    Effect.map(
      (rowGroups) => new Set(rowGroups.flatMap((rows) => rows.map((row) => row.threadId))),
    ),
  );

/**
 * Builds both stream views over one shared store. Setup failures are logged
 * and downgraded to the no-op service so diagnostics never block startup.
 *
 * The `taintedThreads` lookup reads the shared persistence client's
 * `project_memory_send_attempts` rows — committed memory-send attempts are the
 * taint oracle — over the same memoized `SqlClient` the ledger writes through.
 * Taint classification and caching stay inside the store; this layer only
 * supplies the lookup and never interprets it.
 *
 * @public Service construction is part of the canonical Effect module API.
 */
export const make = Effect.gen(function* () {
  const { providerEventLogPath } = yield* ServerConfig;
  const attribution = yield* ResourceAttribution.ResourceAttribution;
  const sql = yield* SqlClient.SqlClient;
  const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
    attribution,
    taintedThreads: (threadIds) => lookupTaintedThreads(sql, threadIds),
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning(error.message, { error }).pipe(
        Effect.annotateLogs({ scope: "provider-observability" }),
        Effect.as<EventNdjsonLogger.EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );

  if (!store) {
    return ProviderEventLoggers.of(NoOpProviderEventLoggers);
  }

  yield* Effect.addFinalizer(() => store.close());
  return ProviderEventLoggers.of({
    native: store.logger("native"),
    canonical: store.logger("canonical"),
  });
});

export const layer = Layer.effect(ProviderEventLoggers, make);
