import type { ProviderRuntimeEvent, ThreadId } from "@t3tools/contracts";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A-ECHO-1: withholds provider-originated free text before ingestion persists
 * it, on threads that have committed a project memory send. A thread is
 * tainted when `project_memory_send_attempts` holds any row for it, in any
 * state — the send commits before the provider can run, so every runtime event
 * of a memory-bearing conversation arrives already tainted.
 *
 * This filter is prospective only. It rewrites nothing already stored, makes
 * no claim about historical sends or stored events, and projections rebuilt
 * from old events stay as they were.
 *
 * A-ECHO-2 widens the covered shapes (see `carriesMemoryEchoField`): denial
 * reasons, task error/summary diagnostics, and Claude error-bearing assistant
 * snapshots. The Claude branch is diagnostic masking bounded to one provenance
 * — a snapshot-backfilled SDK assistant message stamped `claude/assistant`
 * whose `error` field is set. A normal snapshot carries the same stamp, so the
 * SDK message's own error field is the discriminator. Any other non-empty
 * string error is masked conservatively (SDK enum is not consulted).
 * `max_output_tokens` is the bounded compatibility exception in this slice —
 * not a claim that every such payload is verified normal output. Provenance
 * that does not match (wrong provider/source/method, missing type/error,
 * empty error, non-object payload) stays untouched: unverified, not proven
 * safe. The raw field still carries the original payload for every masked
 * event — only the persisted copies are withheld.
 *
 * Explicitly left unprotected — named follow-up obligations, not fixed here:
 * the ProviderService-owned `provider_session_runtime.runtime_payload.lastError`
 * copy and `thread.history.import`, which does not pass through ingestion at
 * all.
 *
 * Lane B consumers import `lookupMemoryEchoThreadState` and
 * `memoryEchoThreadShouldWithhold` — tri-state verdict, positive-only guard
 * cache stays in `makeMemoryEchoGuard`.
 */

export const MEMORY_ECHO_WITHHELD_ERROR =
  "Provider error details are hidden because this thread used project memory.";

export const MEMORY_ECHO_WITHHELD_NOTICE =
  "Provider notice details are hidden because this thread used project memory.";

/**
 * Claude error-bearing assistant snapshot provenance: provider, the adapter's
 * snapshot stamp, assistant type, and a non-empty string `error` other than
 * `max_output_tokens`. Objects are not stringified to decide; malformed or
 * empty errors are out of scope for this filter.
 */
const isClaudeErrorAssistantSnapshot = (event: ProviderRuntimeEvent): boolean => {
  if (event.provider !== "claudeAgent" || event.raw === undefined) {
    return false;
  }
  const { raw } = event;
  if (raw.source !== "claude.sdk.message" || raw.method !== "claude/assistant") {
    return false;
  }
  const payload = raw.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const record = payload as { readonly type?: unknown; readonly error?: unknown };
  return (
    record.type === "assistant" &&
    typeof record.error === "string" &&
    record.error.length > 0 &&
    record.error !== "max_output_tokens"
  );
};

/**
 * Whether the event carries a free-text field this slice withholds. False
 * means the guard can return the event untouched without touching SQL —
 * non-target traffic never pays for a lookup (including ordinary deltas,
 * tools, tasks, and Claude frames outside the error snapshot stamp).
 */
export function carriesMemoryEchoField(event: ProviderRuntimeEvent): boolean {
  switch (event.type) {
    case "runtime.error":
    case "runtime.warning":
      return true;
    case "turn.completed":
      return event.payload.errorMessage !== undefined;
    case "session.state.changed":
      return (
        event.payload.state === "error" &&
        (event.payload.reason !== undefined || event.payload.detail !== undefined)
      );
    case "thread.metadata.updated":
      return event.payload.name !== undefined;
    case "thread.state.changed":
      return event.payload.state === "compacted" && event.payload.detail !== undefined;
    case "tool.denied":
      return event.payload.reason !== undefined;
    case "task.progress":
    case "task.updated":
      return event.payload.error !== undefined;
    case "task.completed":
      return event.payload.status === "failed" && event.payload.summary !== undefined;
    case "content.delta":
      return event.payload.streamKind === "assistant_text" && isClaudeErrorAssistantSnapshot(event);
    case "item.completed":
      return (
        event.payload.itemType === "assistant_message" && isClaudeErrorAssistantSnapshot(event)
      );
    default:
      return false;
  }
}

/**
 * Pure. Returns the same reference when nothing is withheld; otherwise
 * replaces the echo-prone text with the fixed phrase and drops raw `detail`.
 * Never touches ids, turn state, usage, `tokenUsage`, or the enum-typed
 * `class`. `runtime.error.code` is dropped, not preserved: the contract types
 * it as a free provider string, so a marker there must not survive.
 *
 * The A-ECHO-2 shapes keep their rows' meaning instead of deleting fields:
 * `task.progress`/`task.updated` errors are replaced so the progress row they
 * justify still persists, a failed `task.completed` keeps its "Task failed"
 * label and loses only the free-text summary, and a Claude error snapshot
 * keeps its item id and title with only the text replaced.
 */
export function withholdMemoryEcho(event: ProviderRuntimeEvent): ProviderRuntimeEvent {
  if (!carriesMemoryEchoField(event)) {
    return event;
  }
  switch (event.type) {
    case "runtime.error":
      return {
        ...event,
        payload: {
          message: MEMORY_ECHO_WITHHELD_ERROR,
          ...(event.payload.class !== undefined ? { class: event.payload.class } : {}),
        },
      };
    case "runtime.warning":
      return { ...event, payload: { message: MEMORY_ECHO_WITHHELD_NOTICE } };
    case "turn.completed":
      return {
        ...event,
        payload: { ...event.payload, errorMessage: MEMORY_ECHO_WITHHELD_ERROR },
      };
    case "session.state.changed":
      return {
        ...event,
        payload: {
          state: event.payload.state,
          ...(event.payload.reason !== undefined ? { reason: MEMORY_ECHO_WITHHELD_ERROR } : {}),
        },
      };
    case "thread.metadata.updated":
      return {
        ...event,
        payload: event.payload.metadata !== undefined ? { metadata: event.payload.metadata } : {},
      };
    case "thread.state.changed":
      return {
        ...event,
        payload: {
          state: event.payload.state,
          ...(event.payload.beforeTokens !== undefined
            ? { beforeTokens: event.payload.beforeTokens }
            : {}),
          ...(event.payload.afterTokens !== undefined
            ? { afterTokens: event.payload.afterTokens }
            : {}),
        },
      };
    case "tool.denied": {
      const payload = { ...event.payload };
      delete payload.reason;
      return { ...event, payload };
    }
    case "task.progress":
      return {
        ...event,
        payload: {
          ...event.payload,
          ...(event.payload.error !== undefined ? { error: MEMORY_ECHO_WITHHELD_ERROR } : {}),
        },
      };
    case "task.updated":
      return {
        ...event,
        payload: {
          ...event.payload,
          ...(event.payload.error !== undefined ? { error: MEMORY_ECHO_WITHHELD_ERROR } : {}),
        },
      };
    case "task.completed": {
      const payload = { ...event.payload };
      delete payload.summary;
      return { ...event, payload };
    }
    case "content.delta":
      return {
        ...event,
        payload: { ...event.payload, delta: MEMORY_ECHO_WITHHELD_ERROR },
      };
    case "item.completed":
      return {
        ...event,
        payload: {
          ...event.payload,
          ...(event.payload.detail !== undefined ? { detail: MEMORY_ECHO_WITHHELD_ERROR } : {}),
        },
      };
    default:
      return event;
  }
}

const LOOKUP_FAILED_LOG =
  "Project memory echo lookup failed; withholding provider diagnostics for this event.";

/** Durable send-ledger verdict for one thread. Shared by ingestion and directory. */
export type MemoryEchoThreadState = "clean" | "tainted" | "unavailable";

/** Whether provider diagnostics on this thread should be withheld for the current write. */
export const memoryEchoThreadShouldWithhold = (state: MemoryEchoThreadState): boolean =>
  state !== "clean";

/**
 * Reads `project_memory_send_attempts` for one thread using the caller's
 * SqlClient. Only a successful SELECT with a row yields `tainted`. Lookup
 * failures and defects yield `unavailable` after a fixed warning with no
 * cause. Interrupts, including mixed causes, propagate unchanged.
 */
export const lookupMemoryEchoThreadState = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
): Effect.Effect<MemoryEchoThreadState, SqlError> =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      sql`SELECT 1 FROM project_memory_send_attempts WHERE thread_id = ${threadId} LIMIT 1`,
    );
    if (Exit.isSuccess(exit)) {
      return exit.value.length === 0 ? "clean" : "tainted";
    }
    const cause = exit.cause;
    if (Cause.hasInterrupts(cause)) {
      return yield* Effect.failCause(cause);
    }
    yield* Effect.logWarning(LOOKUP_FAILED_LOG);
    return "unavailable";
  });

/**
 * Builds the ingestion guard over one SqlClient. The attempt lookup is
 * positive-only cached for the guard's lifetime; clean and unavailable answers
 * are never cached, so the next echo-bearing event re-reads the durable row.
 * Lookup failures and defects fail closed — fixed log text only, no cause and
 * no event content — without caching the failure. A cause carrying an
 * interrupt, pure or mixed with anything else, propagates as the original
 * cause before the event can reach dispatch.
 */
export const makeMemoryEchoGuard = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const taintedThreadIds = new Set<ThreadId>();

  return (event: ProviderRuntimeEvent) => {
    if (!carriesMemoryEchoField(event)) {
      return Effect.succeed(event);
    }
    if (taintedThreadIds.has(event.threadId)) {
      // Cache hit and withheld result are produced in one synchronous step,
      // so an interruption landing in this window still cannot return the
      // raw event.
      return Effect.succeed(withholdMemoryEcho(event));
    }
    return Effect.gen(function* () {
      const state = yield* lookupMemoryEchoThreadState(sql, event.threadId);
      if (state === "clean") {
        return event;
      }
      if (state === "tainted") {
        return yield* Effect.sync(() => {
          taintedThreadIds.add(event.threadId);
          return withholdMemoryEcho(event);
        });
      }
      return withholdMemoryEcho(event);
    });
  };
});
