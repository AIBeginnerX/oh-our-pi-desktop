import {
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  ProviderDriverKind,
  ProviderInstanceId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

/**
 * Validated native provider session references.
 *
 * A binding's resume cursor only remembers the session id it currently
 * points at; resume renegotiation, rollback forks, restarts, and provider
 * switches orphan earlier native ids that the agent-session importer must
 * never re-import. This module owns the validated ref
 * (`{provider, providerInstanceId, sessionId}`), the narrow cursor read
 * that produces one, and the `runtimePayload` metadata
 * (`PRIOR_PROVIDER_SESSION_IDS_KEY`) under which
 * `ProviderSessionDirectory` preserves a thread's earlier refs inside its
 * per-thread write lock. The importer combines the current cursor with
 * this metadata and excludes conservatively on the `(provider, sessionId)`
 * pair across instance aliases; stored refs keep the original instance.
 *
 * @module providerSessionIds
 */

/** `runtimePayload` key under which a binding's earlier native session refs are preserved. */
export const PRIOR_PROVIDER_SESSION_IDS_KEY = "priorProviderSessionIds";

/**
 * One stored native session ref. `providerInstanceId` is the instance that
 * produced the session when the ref was recorded: exclusion keys collapse
 * instance aliases, storage never does.
 */
export const ProviderSessionRef = Schema.Struct({
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId,
  sessionId: TrimmedNonEmptyString,
});
export type ProviderSessionRef = typeof ProviderSessionRef.Type;

/**
 * Raised when a `runtimePayload` carries `priorProviderSessionIds` that
 * does not decode. Callers must fail ownership decisions loudly instead of
 * treating the binding as if it owned nothing.
 */
export class ProviderSessionRefsMalformedError extends Schema.TaggedError<ProviderSessionRefsMalformedError>()(
  "ProviderSessionRefsMalformedError",
  {
    operation: Schema.String,
    issue: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider session refs metadata is malformed in ${this.operation}: ${this.issue}`;
  }
}

// Same shape ClaudeAdapter accepts as a native Claude session id.
const CLAUDE_SESSION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isProviderInstanceId = Schema.is(ProviderInstanceId);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Narrow read of the native session id a resume cursor carries — Claude's
 * `{resume}` (or legacy `{sessionId}`, UUID-only) and Codex's `{threadId}`.
 * Unknown providers and unknown cursor shapes yield `undefined`: opaque
 * cursors are never stringified, so an arbitrary payload can never pass as
 * an owned session id. Only Claude and Codex are scanner sources.
 */
export const providerSessionIdOf = (
  provider: ProviderDriverKind,
  resumeCursor: unknown,
): string | undefined => {
  if (!isRecord(resumeCursor)) {
    return undefined;
  }
  if (provider === "claudeAgent") {
    const candidate =
      typeof resumeCursor.resume === "string"
        ? resumeCursor.resume
        : typeof resumeCursor.sessionId === "string"
          ? resumeCursor.sessionId
          : undefined;
    return candidate !== undefined && CLAUDE_SESSION_ID_PATTERN.test(candidate)
      ? candidate
      : undefined;
  }
  if (provider === "codex") {
    const candidate = resumeCursor.threadId;
    return typeof candidate === "string" && candidate.trim() !== "" ? candidate : undefined;
  }
  return undefined;
};

/**
 * The binding-level ref for a stored row: the cursor is interpreted under
 * the row's own provider and instance, with a legacy null instance
 * promoted exactly like the directory promotes it on read. A row whose
 * provider slug, instance, or cursor shape cannot be validated has no ref;
 * a valid session id is never dropped for carrying an unusable identity.
 */
export const nativeSessionRefOf = (
  providerName: string,
  providerInstanceId: string | null,
  resumeCursor: unknown,
): Option.Option<ProviderSessionRef> => {
  if (!isProviderDriverKind(providerName)) {
    return Option.none();
  }
  const sessionId = providerSessionIdOf(providerName, resumeCursor);
  if (sessionId === undefined) {
    return Option.none();
  }
  const instance = providerInstanceId ?? defaultInstanceIdForDriver(providerName);
  if (!isProviderInstanceId(instance)) {
    return Option.none();
  }
  return Option.some({ provider: providerName, providerInstanceId: instance, sessionId });
};

const decodeRefsExit = Schema.decodeUnknownExit(Schema.Array(ProviderSessionRef));

/**
 * Validated read of the preserved refs metadata: an absent key (or a
 * non-record payload) means no preserved refs, a present-but-malformed key
 * fails loudly.
 */
export const readPriorProviderSessionRefs = (
  runtimePayload: unknown,
): Result.Result<ReadonlyArray<ProviderSessionRef>, ProviderSessionRefsMalformedError> => {
  if (!isRecord(runtimePayload)) {
    return Result.succeed([]);
  }
  const refs = runtimePayload[PRIOR_PROVIDER_SESSION_IDS_KEY];
  if (refs === undefined) {
    return Result.succeed([]);
  }
  const decoded = decodeRefsExit(refs);
  if (Exit.isFailure(decoded)) {
    return Result.fail(
      new ProviderSessionRefsMalformedError({
        operation: "providerSessionIds.readPriorProviderSessionRefs",
        issue: `'${PRIOR_PROVIDER_SESSION_IDS_KEY}' is present but is not an array of {provider, providerInstanceId, sessionId} refs.`,
        cause: decoded.cause,
      }),
    );
  }
  return Result.succeed(decoded.value);
};

/** The stored row fields a preservation merge reads. */
export interface ProviderSessionRuntimeSnapshot {
  readonly providerName: string;
  readonly providerInstanceId: string | null;
  readonly resumeCursor: unknown;
  readonly runtimePayload: unknown;
}

/** The effective provider identity and cursor an upsert is about to store. */
export interface ProviderSessionRuntimePatchIdentity {
  readonly providerName: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly resumeCursor: unknown;
}

function dedupStoredRefs(
  refs: ReadonlyArray<ProviderSessionRef>,
): ReadonlyArray<ProviderSessionRef> {
  const seen = new Set<string>();
  const kept: Array<ProviderSessionRef> = [];
  for (const ref of refs) {
    const key = `${ref.provider}\u0000${ref.providerInstanceId}\u0000${ref.sessionId}`;
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(ref);
    }
  }
  return kept;
}

/**
 * Pure heart of the directory's locked preservation; the caller holds the
 * per-thread lock and resolves the effective identity and cursor about to
 * be stored. The union is monotone — the stored refs, the refs the merged
 * payload carries, and the row's current native ref unless the next cursor
 * still stores that exact ref — deduped on the full stored identity and
 * never truncated. Malformed metadata on either side fails.
 */
export const preservePriorProviderSessionRefs = (input: {
  readonly existing: ProviderSessionRuntimeSnapshot;
  readonly next: ProviderSessionRuntimePatchIdentity;
  /** Payload the upsert would store after its own shallow merge. */
  readonly mergedRuntimePayload: unknown | null;
}): Result.Result<ReadonlyArray<ProviderSessionRef>, ProviderSessionRefsMalformedError> => {
  const existingRefs = readPriorProviderSessionRefs(input.existing.runtimePayload);
  if (!Result.isSuccess(existingRefs)) {
    return existingRefs;
  }
  const nextRefs = readPriorProviderSessionRefs(input.mergedRuntimePayload);
  if (!Result.isSuccess(nextRefs)) {
    return nextRefs;
  }
  const currentRef = nativeSessionRefOf(
    input.existing.providerName,
    input.existing.providerInstanceId,
    input.existing.resumeCursor,
  );
  const nextRef = nativeSessionRefOf(
    input.next.providerName,
    input.next.providerInstanceId,
    input.next.resumeCursor,
  );
  const refs: Array<ProviderSessionRef> = [...existingRefs.success, ...nextRefs.success];
  if (
    Option.isSome(currentRef) &&
    (Option.isNone(nextRef) || !sameStoredRef(currentRef.value, nextRef.value))
  ) {
    refs.push(currentRef.value);
  }
  return Result.succeed(dedupStoredRefs(refs));
};

function sameStoredRef(left: ProviderSessionRef, right: ProviderSessionRef): boolean {
  return (
    left.provider === right.provider &&
    left.providerInstanceId === right.providerInstanceId &&
    left.sessionId === right.sessionId
  );
}
