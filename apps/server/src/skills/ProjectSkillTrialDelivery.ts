/**
 * ProjectSkillTrialDelivery — canonical input resolution plus the claim/settle
 * wrapper over `ProjectSkillTrialRepository` for managed `project-skill`
 * context sends (S4 delivery slice).
 *
 * `resolveInput` answers the durable canonical input for `(threadId,
 * messageId)`: exactly one committed user `thread.message-sent` event inside
 * the thread's latest incarnation — the window between the newest
 * `thread.created` and the first `thread.deleted`/`thread.created` after it —
 * carrying exactly one well-formed trial record with the server stamp. All
 * event fields are read in one snapshot transaction, and every selected row is
 * decoded whole through the persisted-event envelope (`OrchestrationEvent`
 * with the event store's persisted-row mapping) so wrapper metadata and
 * `occurredAt` are proven too; a `json_extract` prefilter is only a coarse row
 * limit, never proof of identity. A row claiming the target message id that
 * fails the envelope is an ambiguous candidate — refusal, never silently
 * skipped for an older valid one. The canonical message's raw context records
 * are scanned for an exact `memory` kind before compatibility decoding, since
 * forward-compatible decoding would drop a malformed record first. Missing or
 * ambiguous inputs answer `Option.none()`; nothing here falls back to an
 * ordinary send.
 *
 * `claim` re-derives that tuple internally immediately before handing it to
 * the repository: a caller can never pair a different event, ref, or stamp,
 * because it never supplies one. Only the repository's definite `entered`
 * result (the invocation whose INSERT committed) becomes `Entered`; every
 * other outcome — an existing `unknown` or accepted row, stale identity,
 * recreation, moved ref/state, missing input, resolve miss, or failure — is
 * the fixed `Held("unavailable")`. `now` is always server-sampled. An
 * `Entered` also carries the ephemeral `expectedBlock`: the canonical
 * managed block re-derived from the immutable stored version the ref names —
 * never a client-supplied block — so a settlement can only ever prove the
 * exact bytes this server would have queued.
 *
 * `settle` is bound to the captured `Entered` result (its identity and
 * one-time token) plus the actual routed driver — never caller-supplied
 * replacement values. `applied` and `already-final` finish quietly; every
 * other outcome or ordinary failure leaves `unknown` durable and records at
 * most the fixed diagnostic, so settlement can never manufacture acceptance.
 * When the caller also passes the actual enter-route `providerInstanceId`
 * and the publish-step `submission` observation, a fully matching managed
 * capture — Claude driver, equal instance/driver, well-formed native session
 * and generation, a lowercase-hex route digest, and the expected block
 * counted exactly once inside exactly one actual SDK text block — pins a
 * `managed_send_json` label inside the same acceptance UPDATE. Anything
 * short of a match is still ordinary accepted delivery, permanently
 * unlabelled.
 *
 * Error channel: private server plumbing with an honest `unknown` channel.
 * A cause carrying any interrupt reason is returned whole via `failCause` —
 * interruption is never turned into a held decision, a swallowed settle, or
 * a cast `Cause<never>`. Every other failure collapses to the fixed held
 * decision / diagnostic, or the fixed persistence error on `resolveInput`.
 *
 * The `Context.Reference` default is fail-closed: a composition that never
 * wired delivery resolves nothing, holds every claim `unavailable`, and
 * settles nothing — it is never a substitute for the real service.
 */
import {
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  PROJECT_SKILL_CONTEXT_KIND,
  ProjectId,
  ProjectSkillContent,
  ProjectSkillContextPayload,
  ProjectSkillEnvironment,
  ProviderDriverKind,
  SelectedChecksRunInput,
  ThreadId,
  ThreadMessageSentPayload,
  canonicalProjectSkillContentJson,
  renderProjectSkillBlock,
} from "@t3tools/contracts";
import type {
  MessageId,
  ProjectSkillManagedSendEvidence,
  ProjectSkillVersionRef,
  ProviderInstanceId,
  ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceDecodeError, PersistenceSqlError } from "../persistence/Errors.ts";
import { ProjectSkillTrialRepository } from "../persistence/ProjectSkillTrials.ts";
import type { ProviderAdmissionObservation } from "../provider/Services/ProviderAdapter.ts";
import {
  ProviderService,
  type ProviderSkillTrialHandoff,
  type ProviderSkillTrialRoute,
} from "../provider/Services/ProviderService.ts";
import type { SelectedChecksTargetPlan } from "../selectedChecks/SelectedChecks.ts";
import { SelectedChecks } from "../selectedChecks/SelectedChecks.ts";
import {
  ProjectSkillMutationFence,
  ProjectSkillMutationFenceStaleExpect,
  type ProjectSkillMutationToken,
} from "./ProjectSkillMutationFence.ts";

/**
 * The canonical delivery identity, derived from durable input only. Frozen:
 * consumers read it, nothing rewrites it. `inputEventSequence` is the
 * committed user `thread.message-sent` event — never a turn-request sequence.
 */
export interface ProjectSkillTrialDeliveryIdentity {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly projectId: ProjectId;
  readonly ref: ProjectSkillVersionRef;
  readonly inputEventSequence: number;
  readonly admittedSkillStateSeq: number;
  readonly mode: "trial" | "use";
  /** Present only for durable `use` inputs; order is authoritative. */
  readonly selectedScriptIds?: ReadonlyArray<string>;
}

/** The one held reason this slice reports; no outcome names cross. */
export type ProjectSkillTrialDeliveryHoldReason = "unavailable";

/** A claim whose INSERT committed; carries the captured tuple and token. */
export interface ProjectSkillTrialDeliveryEntered {
  readonly _tag: "Entered";
  readonly identity: ProjectSkillTrialDeliveryIdentity;
  readonly attemptToken: string;
  /**
   * The canonical managed block derived at claim from the immutable stored
   * version — full ref match, whole-content decode, and canonical rehash to
   * the stored ref hash. Ephemeral, never persisted; absent means no managed
   * capture can label the settlement while ordinary accepted delivery stays
   * possible.
   */
  readonly expectedBlock?: string;
}

export interface ProjectSkillTrialDeliveryHeld {
  readonly _tag: "Held";
  readonly reason: ProjectSkillTrialDeliveryHoldReason;
}

export type ProjectSkillTrialDeliveryClaimOutcome =
  | ProjectSkillTrialDeliveryEntered
  | ProjectSkillTrialDeliveryHeld;

export type ProjectSkillTrialUseHandoffOutcome =
  | { readonly _tag: "Handoff"; readonly handoff: ProviderSkillTrialHandoff }
  | ProjectSkillTrialDeliveryHeld;

/**
 * The private settle-time submission (C2): the adapter's publish-step
 * observation plus its actual routed instance and driver — the same
 * `ProviderAdmissionObservation & ProviderSkillTrialRoute` the service
 * hands `observeSubmission`. A send without a `submissionCandidate` simply
 * produces no managed evidence; ordinary accepted delivery stays possible.
 */
export type ProjectSkillTrialSubmission = ProviderAdmissionObservation & ProviderSkillTrialRoute;

/**
 * Honest private channel: fixed persistence failures for ordinary errors, or
 * the original cause — Fail/Die legs included — when it carries an interrupt.
 */
export type ProjectSkillTrialDeliveryError = PersistenceSqlError | PersistenceDecodeError | unknown;

export interface ProjectSkillTrialDeliveryService {
  readonly resolveInput: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<
    Option.Option<ProjectSkillTrialDeliveryIdentity>,
    ProjectSkillTrialDeliveryError
  >;
  readonly claim: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<ProjectSkillTrialDeliveryClaimOutcome, unknown>;
  readonly settle: (input: {
    readonly entered: ProjectSkillTrialDeliveryEntered;
    readonly providerDriverKind: ProviderDriverKind;
    /** The actual instance captured at the enter route — never caller-shaped. */
    readonly providerInstanceId?: ProviderInstanceId;
    /** The publish-time observation including its actual route (private). */
    readonly submission?: ProjectSkillTrialSubmission;
  }) => Effect.Effect<void, unknown>;
  readonly useHandoff: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly intendedProviderInstanceId: ProviderInstanceId;
    readonly sendTurn: ProviderSendTurnInput;
    readonly onEntered?: (
      entered: ProjectSkillTrialDeliveryEntered,
      routed: ProviderSkillTrialRoute,
    ) => void;
  }) => Effect.Effect<ProjectSkillTrialUseHandoffOutcome, unknown>;
}

/**
 * Fixed settle diagnostic: no outcome names, ids, or causes. `unknown` stays
 * durable either way — this is the most a failed settlement may say.
 */
export const PROJECT_SKILL_TRIAL_SETTLE_WARNING =
  "project-skill trial delivery settlement was not recorded";

const heldUnavailable: ProjectSkillTrialDeliveryHeld = {
  _tag: "Held",
  reason: "unavailable",
};

/**
 * The fail-closed default: a send this composition never wired is held
 * `unavailable` whenever it reaches for managed delivery, and settles nothing.
 */
const unavailableDelivery: ProjectSkillTrialDeliveryService = {
  resolveInput: () => Effect.succeed(Option.none()),
  claim: () => Effect.succeed(heldUnavailable),
  settle: () => Effect.void,
  useHandoff: () => Effect.succeed(heldUnavailable),
};

export class ProjectSkillTrialDelivery extends Context.Reference<ProjectSkillTrialDeliveryService>(
  "t3/skills/ProjectSkillTrialDelivery",
  { defaultValue: () => unavailableDelivery },
) {}

// The reserved memory kind is private inside shared/composerContextReferences.ts
// (PROJECT_MEMORY_REFERENCE_KIND) and is duplicated by value here on purpose.
const PROJECT_MEMORY_CONTEXT_KIND = "memory";

// The event store's persisted-row mapping (OrchestrationEventStore.ts): the
// same column aliases land on these fields, `payload_json` is parsed to
// unknown, and `metadata_json` is proven through the metadata schema.
const OrchestrationEventPersistedRow = Schema.Struct({
  sequence: NonNegativeInt,
  eventId: EventId,
  type: OrchestrationEventType,
  aggregateKind: OrchestrationAggregateKind,
  aggregateId: Schema.Union([ProjectId, ThreadId]),
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  payload: Schema.fromJsonString(Schema.Unknown),
  metadata: Schema.fromJsonString(OrchestrationEventMetadata),
});
const decodePersistedRow = Schema.decodeUnknownExit(OrchestrationEventPersistedRow);
const decodePersistedEvent = Schema.decodeUnknownExit(OrchestrationEvent);
const decodeSkillContextPayload = Schema.decodeUnknownOption(ProjectSkillContextPayload);

/**
 * A selected row becomes a proven event only through the full two-stage
 * persisted-envelope decode; the raw parsed payload rides along so callers
 * can inspect declarations that compatibility decoding would drop.
 */
const rowToEvent = (
  row: unknown,
): Option.Option<{
  readonly event: OrchestrationEvent;
  readonly rawPayload: unknown;
}> => {
  const rowExit = decodePersistedRow(row);
  if (Exit.isFailure(rowExit)) return Option.none();
  const eventExit = decodePersistedEvent(rowExit.value);
  if (Exit.isFailure(eventExit)) return Option.none();
  return Option.some({ event: eventExit.value, rawPayload: rowExit.value.payload });
};

/** Raw parsed `context.records` inside a decoded-but-untrusted payload. */
const rawContextRecords = (payload: unknown): ReadonlyArray<unknown> | undefined => {
  if (typeof payload !== "object" || payload === null) return undefined;
  const context = (payload as { readonly context?: unknown }).context;
  if (typeof context !== "object" || context === null) return undefined;
  const records = (context as { readonly records?: unknown }).records;
  return Array.isArray(records) ? records : undefined;
};

/**
 * An object declares the managed memory kind by exact `kind` only — never
 * scanned from text, matching `declaresProjectSkillKind` in composerContext.
 */
const declaresMemoryKind = (record: unknown): boolean =>
  typeof record === "object" &&
  record !== null &&
  !Array.isArray(record) &&
  (record as { readonly kind?: unknown }).kind === PROJECT_MEMORY_CONTEXT_KIND;

const decodeProjectSkillEnvironment = Schema.decodeUnknownEffect(ProjectSkillEnvironment);

const planIdentityKey = (plan: SelectedChecksTargetPlan): string =>
  JSON.stringify({
    threadId: plan.threadId,
    projectId: plan.projectId,
    workspaceRoot: plan.workspaceRoot,
    worktreePath: plan.worktreePath,
    cwd: plan.cwd,
    shell: plan.shell,
    envSha256: plan.envSha256,
    platform: plan.platform,
    arch: plan.arch,
    planned: plan.planned,
  });

const previewIdentityKey = (
  route:
    | {
        readonly providerInstanceId: string;
        readonly driverKind: string;
        readonly routePreview?: {
          readonly sessionGeneration: number;
          readonly nativeSessionId: string;
          readonly routeConfigSha256: string;
        };
      }
    | undefined,
): string | undefined =>
  route === undefined
    ? undefined
    : JSON.stringify({
        providerInstanceId: route.providerInstanceId,
        driverKind: route.driverKind,
        routePreview: route.routePreview,
      });

const durableSelectedScriptIds = (
  payload: ProjectSkillContextPayload,
): ReadonlyArray<string> | undefined => {
  if (payload.mode !== "use") return undefined;
  const ids = payload.selectedScriptIds;
  if (ids === undefined || ids.length === 0) return undefined;
  if (ids.some((id) => typeof id !== "string" || id.trim().length === 0)) return undefined;
  return ids;
};

const planScriptIds = (plan: SelectedChecksTargetPlan): ReadonlyArray<string> =>
  plan.planned.map((entry) => entry.scriptId);

const scriptIdsEqual = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
};

const toSelectedChecksScriptIds = (
  scriptIds: ReadonlyArray<string>,
): SelectedChecksRunInput["scriptIds"] | undefined => {
  const first = scriptIds[0];
  if (first === undefined || first.trim().length === 0) return undefined;
  const rest = scriptIds.slice(1);
  return rest.length === 0 ? [first] : [first, ...rest];
};

const planLookupFailed = (cause: Cause.Cause<unknown>): Effect.Effect<undefined, unknown> =>
  Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(undefined);

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const trials = yield* ProjectSkillTrialRepository;
  const crypto = yield* Crypto.Crypto;
  const mutationFence = yield* ProjectSkillMutationFence;
  const selectedChecks = yield* SelectedChecks;
  const provider = yield* ProviderService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;

  // Same hex encoding as the other skills modules; duplicated by value.
  const toHex = (bytes: Uint8Array): string => {
    const digits = "0123456789abcdef";
    let hex = "";
    for (const byte of bytes) hex += digits.charAt(byte >> 4) + digits.charAt(byte & 15);
    return hex;
  };

  const sha256Utf8 = (text: string) =>
    Effect.map(crypto.digest("SHA-256", new TextEncoder().encode(text)), toHex);

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const sqlError = (operation: string) => new PersistenceSqlError({ operation });

  /**
   * `resolveInput`'s error boundary: an interrupt-bearing cause is returned
   * whole via `failCause`; every other failure — statement or transaction
   * boundary — collapses to the fixed local persistence error.
   */
  const refineRead = <A>(
    operation: string,
    work: Effect.Effect<A, unknown>,
  ): Effect.Effect<A, ProjectSkillTrialDeliveryError> =>
    work.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(sqlError(operation)),
      ),
    );

  const resolveInput: ProjectSkillTrialDeliveryService["resolveInput"] = (input) => {
    const operation = "ProjectSkillTrialDelivery.resolveInput";
    const eventColumns = sql`
      sequence AS "sequence",
      event_id AS "eventId",
      event_type AS "type",
      aggregate_kind AS "aggregateKind",
      stream_id AS "aggregateId",
      occurred_at AS "occurredAt",
      command_id AS "commandId",
      causation_event_id AS "causationEventId",
      correlation_id AS "correlationId",
      payload_json AS "payload",
      metadata_json AS "metadata"
    `;
    return refineRead(
      operation,
      sql.withTransaction(
        Effect.gen(function* () {
          // Latest incarnation first, unfiltered: a conflicting newer
          // thread.created must win the window, never be skipped by a
          // decode or content check.
          const incarnationRows = yield* sql<Record<string, unknown>>`
            SELECT ${eventColumns}
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
              AND event_type = 'thread.created'
            ORDER BY sequence DESC
            LIMIT 1
          `;
          const incarnationRow = incarnationRows[0];
          if (incarnationRow === undefined) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }

          // The governing creation is proven through the persisted envelope:
          // type, aggregate binding, payload identity, metadata, and
          // occurredAt all decode. A malformed latest creation refuses —
          // never falls back to an older one.
          const incarnationDecoded = rowToEvent(incarnationRow);
          if (Option.isNone(incarnationDecoded)) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          const incarnation = incarnationDecoded.value.event;
          if (
            incarnation.type !== "thread.created" ||
            incarnation.aggregateKind !== "thread" ||
            incarnation.aggregateId !== input.threadId ||
            incarnation.payload.threadId !== input.threadId
          ) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          const projectId = incarnation.payload.projectId;

          // The incarnation's live window ends at the first lifecycle event
          // after it: only a `thread.deleted` can sit there (a newer created
          // would itself be the latest incarnation).
          const boundaryRows = yield* sql<{ readonly boundary: number | null }>`
            SELECT MIN(sequence) AS "boundary"
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
              AND event_type IN ('thread.created', 'thread.deleted')
              AND sequence > ${incarnation.sequence}
          `;
          const windowEnd = boundaryRows[0]?.boundary ?? null;

          // The messageId prefilter only limits rows; every candidate is
          // proven by decoding the persisted event envelope whole.
          const candidateRows = yield* sql<Record<string, unknown>>`
            SELECT ${eventColumns}
            FROM orchestration_events
            WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
              AND event_type = 'thread.message-sent'
              AND sequence > ${incarnation.sequence}
              AND json_extract(payload_json, '$.messageId') = ${input.messageId}
            ORDER BY sequence ASC
          `;
          const canonical: Array<{
            readonly sequence: number;
            readonly message: typeof ThreadMessageSentPayload.Type;
            readonly rawPayload: unknown;
          }> = [];
          for (const row of candidateRows) {
            // Outside the live window the row is excluded outright — the
            // coarse sequence bound is enough, no envelope work is owed.
            const sequence = row.sequence;
            if (typeof sequence === "number" && windowEnd !== null && sequence >= windowEnd) {
              continue;
            }
            const decoded = rowToEvent(row);
            if (Option.isNone(decoded)) {
              // A row claiming the target message id that fails the
              // persisted envelope is an ambiguous candidate — refusal,
              // never a silent skip toward an older valid row.
              return Option.none<ProjectSkillTrialDeliveryIdentity>();
            }
            const { event, rawPayload } = decoded.value;
            if (
              event.type !== "thread.message-sent" ||
              event.aggregateKind !== "thread" ||
              event.aggregateId !== input.threadId
            ) {
              continue;
            }
            const message = event.payload;
            if (
              message.threadId !== input.threadId ||
              message.messageId !== input.messageId ||
              message.role !== "user"
            ) {
              continue;
            }
            canonical.push({ sequence: event.sequence, message, rawPayload });
          }
          // Exactly one canonical user message is required; zero is missing
          // and more is ambiguous — both are never an ordinary send.
          const candidate = canonical.length === 1 ? canonical[0] : undefined;
          if (candidate === undefined) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }

          // Raw parsed records precede compatibility decoding: any object
          // declaring the exact `memory` kind refuses the managed input —
          // forward-compatible decoding would drop a malformed memory record
          // before the decoded record list ever saw it.
          const rawRecords = rawContextRecords(candidate.rawPayload);
          if (rawRecords !== undefined && rawRecords.some(declaresMemoryKind)) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          const records = candidate.message.context?.records ?? [];
          const managed = records.filter((record) => record.kind === PROJECT_SKILL_CONTEXT_KIND);
          if (managed.length !== 1) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          const record = managed[0];
          if (record === undefined || !("payload" in record)) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          const context = decodeSkillContextPayload(record.payload);
          if (Option.isNone(context)) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          const payload = context.value;
          // The admitted stamp must be present — never defaulted to zero —
          // and the durable ref must bind the incarnation's own project.
          if (payload.admittedSkillStateSeq === undefined || payload.ref.projectId !== projectId) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          if (payload.mode === "trial") {
            return Option.some<ProjectSkillTrialDeliveryIdentity>(
              Object.freeze({
                threadId: input.threadId,
                messageId: input.messageId,
                projectId,
                ref: payload.ref,
                inputEventSequence: candidate.sequence,
                admittedSkillStateSeq: payload.admittedSkillStateSeq,
                mode: "trial",
              }),
            );
          }
          if (payload.mode !== "use") {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          const selectedScriptIds = durableSelectedScriptIds(payload);
          if (selectedScriptIds === undefined) {
            return Option.none<ProjectSkillTrialDeliveryIdentity>();
          }
          return Option.some<ProjectSkillTrialDeliveryIdentity>(
            Object.freeze({
              threadId: input.threadId,
              messageId: input.messageId,
              projectId,
              ref: payload.ref,
              inputEventSequence: candidate.sequence,
              admittedSkillStateSeq: payload.admittedSkillStateSeq,
              mode: "use",
              selectedScriptIds,
            }),
          );
        }),
      ),
    );
  };

  const decodeSkillContent = Schema.decodeUnknownOption(Schema.fromJsonString(ProjectSkillContent));

  /**
   * The canonical expected block, derived only from the immutable stored
   * version the claim's ref names: full ref match in the store, whole-content
   * decode, and a canonical rehash equal to the stored hash. An arbitrary
   * client-supplied block is never authority.
   */
  const expectedBlockFor = (ref: ProjectSkillVersionRef, mode: "trial" | "use") =>
    Effect.gen(function* () {
      const rows = yield* sql<{ readonly contentJson: unknown }>`
        SELECT content_json AS "contentJson"
        FROM project_skill_versions
        WHERE skill_id = ${ref.skillId} AND project_id = ${ref.projectId}
          AND version = ${ref.version} AND content_sha256 = ${ref.contentSha256}
      `;
      const row = rows[0];
      if (row === undefined || typeof row.contentJson !== "string") {
        return Option.none<string>();
      }
      const content = decodeSkillContent(row.contentJson);
      if (Option.isNone(content)) {
        return Option.none();
      }
      if (
        (yield* sha256Utf8(canonicalProjectSkillContentJson(content.value))) !== ref.contentSha256
      ) {
        return Option.none();
      }
      return Option.some(renderProjectSkillBlock({ ref, content: content.value, mode }));
    });

  const resolveLatestThreadIncarnation = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const incarnationRows = yield* sql<Record<string, unknown>>`
        SELECT sequence AS "sequence", payload_json AS "payload"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND event_type = 'thread.created'
        ORDER BY sequence DESC
        LIMIT 1
      `;
      const row = incarnationRows[0];
      if (row === undefined)
        return Option.none<{ readonly sequence: number; readonly projectId: ProjectId }>();
      const payload = typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
      const sequence = row.sequence;
      if (typeof sequence !== "number" || typeof payload !== "object" || payload === null) {
        return Option.none();
      }
      const threadIdPayload = (payload as { readonly threadId?: unknown }).threadId;
      const projectIdPayload = (payload as { readonly projectId?: unknown }).projectId;
      if (threadIdPayload !== threadId || typeof projectIdPayload !== "string") {
        return Option.none();
      }
      const boundaryRows = yield* sql<{ readonly eventType: string | null }>`
        SELECT event_type AS "eventType"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
          AND event_type IN ('thread.created', 'thread.deleted')
          AND sequence > ${sequence}
        ORDER BY sequence ASC
        LIMIT 1
      `;
      const boundary = boundaryRows[0]?.eventType;
      if (boundary === "thread.deleted" || boundary === "thread.created") {
        return Option.none();
      }
      return Option.some({ sequence, projectId: projectIdPayload as ProjectId });
    });

  /** Non-overlapping occurrence count of `needle` inside `haystack`. */
  const countOccurrences = (haystack: string, needle: string): number => {
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
    return count;
  };

  const SHA256_HEX = /^[0-9a-f]{64}$/;
  const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

  /**
   * The managed-send match: the observed instance and driver must equal the
   * actual captured enter route and the settled driver, the driver must be
   * Claude, the native session and generation must be well-formed, and the
   * observed submission's route digest must be a lowercase SHA-256 hex. The
   * canonical block must occur exactly once inside exactly one actual SDK
   * text block — blocks are counted separately and never concatenated, so a
   * split or duplicated block fabricates nothing.
   */
  const managedSendParts = (input: {
    readonly entered: ProjectSkillTrialDeliveryEntered;
    readonly providerDriverKind: ProviderDriverKind;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly submission?: ProjectSkillTrialSubmission;
  }): Option.Option<{
    readonly expectedBlock: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly providerSessionId: string;
    readonly routeConfigSha256: string;
  }> => {
    const expectedBlock = input.entered.expectedBlock;
    const instanceId = input.providerInstanceId;
    const submission = input.submission;
    // An empty needle would make the occurrence count below never terminate;
    // a missing or non-string block is simply no expected block at all.
    if (
      typeof expectedBlock !== "string" ||
      expectedBlock.length === 0 ||
      instanceId === undefined ||
      submission === undefined
    ) {
      return Option.none();
    }
    if (
      submission.providerInstanceId !== instanceId ||
      submission.driverKind !== input.providerDriverKind ||
      input.providerDriverKind !== CLAUDE_AGENT_DRIVER
    ) {
      return Option.none();
    }
    const nativeSessionId = submission.nativeSessionId;
    if (typeof nativeSessionId !== "string" || nativeSessionId.trim().length === 0) {
      return Option.none();
    }
    if (!Number.isSafeInteger(submission.sessionGeneration) || submission.sessionGeneration < 0) {
      return Option.none();
    }
    const candidate = submission.submissionCandidate;
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      return Option.none();
    }
    const textBlocks = candidate.textBlocks;
    const routeConfigSha256 = candidate.routeConfigSha256;
    if (
      !Array.isArray(textBlocks) ||
      textBlocks.some((block) => typeof block !== "string") ||
      typeof routeConfigSha256 !== "string" ||
      !SHA256_HEX.test(routeConfigSha256)
    ) {
      return Option.none();
    }
    let occurrences = 0;
    for (const block of textBlocks) {
      occurrences += countOccurrences(block, expectedBlock);
    }
    if (occurrences !== 1) {
      return Option.none();
    }
    return Option.some({
      expectedBlock,
      providerInstanceId: instanceId,
      providerSessionId: nativeSessionId,
      routeConfigSha256,
    });
  };

  const claim: ProjectSkillTrialDeliveryService["claim"] = (input) =>
    Effect.gen(function* () {
      // The full tuple is derived from durable input here — immediately
      // before the repository claim re-proves every condition inside its own
      // transaction — never accepted from the caller.
      const resolved = yield* resolveInput(input);
      if (Option.isNone(resolved)) {
        return heldUnavailable;
      }
      const identity = resolved.value;
      const outcome = yield* trials.claimDelivery({ ...identity, now: yield* nowIso });
      // Only the definite committed token enters; an existing claim — in any
      // delivery state — and every refusal is the fixed held answer.
      if (outcome.status !== "entered") {
        return heldUnavailable;
      }
      // Best-effort after the commit: a missing or integrity-failing stored
      // version leaves the entry label-free, never a held claim.
      const expectedBlock = yield* expectedBlockFor(identity.ref, identity.mode).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.succeed(Option.none<string>()),
        ),
      );
      return {
        _tag: "Entered",
        identity,
        attemptToken: outcome.attemptToken,
        ...(Option.isSome(expectedBlock) ? { expectedBlock: expectedBlock.value } : {}),
      } satisfies ProjectSkillTrialDeliveryEntered;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(heldUnavailable),
      ),
    );

  const settleDeliveryWork = (input: {
    readonly entered: ProjectSkillTrialDeliveryEntered;
    readonly projectId: ProjectId;
    readonly providerDriverKind: ProviderDriverKind;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly submission?: ProjectSkillTrialSubmission;
  }) =>
    Effect.gen(function* () {
      const parts = managedSendParts({
        entered: input.entered,
        providerDriverKind: input.providerDriverKind,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        ...(input.submission !== undefined ? { submission: input.submission } : {}),
      });
      let managedSend: Option.Option<ProjectSkillManagedSendEvidence> = Option.none();
      if (Option.isSome(parts)) {
        const matched = parts.value;
        managedSend = yield* Effect.map(sha256Utf8(matched.expectedBlock), (deliveredBlockSha256) =>
          Option.some<ProjectSkillManagedSendEvidence>({
            scope: "managed-procedure/v1",
            deliveredRef: input.entered.identity.ref,
            deliveredBlockSha256,
            providerInstanceId: matched.providerInstanceId,
            providerSessionId: matched.providerSessionId,
            routeConfigSha256: matched.routeConfigSha256,
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.succeed(Option.none<ProjectSkillManagedSendEvidence>()),
          ),
        );
      }
      return yield* trials.settleDelivery({
        threadId: input.entered.identity.threadId,
        messageId: input.entered.identity.messageId,
        projectId: input.projectId,
        attemptToken: input.entered.attemptToken,
        providerDriverKind: input.providerDriverKind,
        now: yield* nowIso,
        ...(Option.isSome(managedSend) ? { managedSend: managedSend.value } : {}),
      });
    });

  const settle: ProjectSkillTrialDeliveryService["settle"] = (input) =>
    Effect.gen(function* () {
      const claimProject = yield* trials.claimProjectForSettlement({
        threadId: input.entered.identity.threadId,
        messageId: input.entered.identity.messageId,
        attemptToken: input.entered.attemptToken,
      });
      if (Option.isNone(claimProject)) {
        yield* Effect.logWarning(PROJECT_SKILL_TRIAL_SETTLE_WARNING);
        return;
      }
      const projectId = claimProject.value;
      const fenceToken = mutationFence.acquire(projectId);
      if (fenceToken === undefined) {
        yield* Effect.logWarning(PROJECT_SKILL_TRIAL_SETTLE_WARNING);
        return;
      }
      const outcome = yield* mutationFence
        .withProjectMutation(
          [projectId],
          settleDeliveryWork({
            entered: input.entered,
            projectId,
            providerDriverKind: input.providerDriverKind,
            ...(input.providerInstanceId !== undefined
              ? { providerInstanceId: input.providerInstanceId }
              : {}),
            ...(input.submission !== undefined ? { submission: input.submission } : {}),
          }),
          { expect: fenceToken },
        )
        .pipe(
          Effect.catchIf(
            (error): error is ProjectSkillMutationFenceStaleExpect =>
              error instanceof ProjectSkillMutationFenceStaleExpect,
            () => Effect.succeed({ status: "not-owned" } as const),
          ),
        );
      if (
        typeof outcome === "object" &&
        outcome !== null &&
        "status" in outcome &&
        outcome.status !== "applied" &&
        outcome.status !== "already-final"
      ) {
        yield* Effect.logWarning(PROJECT_SKILL_TRIAL_SETTLE_WARNING);
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning(PROJECT_SKILL_TRIAL_SETTLE_WARNING),
      ),
    );

  const useHandoff: ProjectSkillTrialDeliveryService["useHandoff"] = (input) =>
    Effect.gen(function* () {
      const resolved = yield* resolveInput({
        threadId: input.threadId,
        messageId: input.messageId,
      });
      if (Option.isNone(resolved) || resolved.value.mode !== "use") {
        return heldUnavailable;
      }
      const identity = resolved.value;
      const selectedScriptIds = identity.selectedScriptIds;
      const runScriptIds =
        selectedScriptIds === undefined ? undefined : toSelectedChecksScriptIds(selectedScriptIds);
      if (runScriptIds === undefined) {
        return heldUnavailable;
      }
      const t0 = mutationFence.acquire(identity.projectId);
      if (t0 === undefined) {
        return heldUnavailable;
      }
      const incarnationBefore = yield* resolveLatestThreadIncarnation(input.threadId);
      if (
        Option.isNone(incarnationBefore) ||
        incarnationBefore.value.projectId !== identity.projectId
      ) {
        return heldUnavailable;
      }
      const planBefore = yield* selectedChecks
        .resolveTargetPlan({
          threadId: input.threadId,
          scriptIds: runScriptIds,
        })
        .pipe(Effect.catchCause(planLookupFailed));
      if (planBefore === undefined || planBefore.projectId !== identity.projectId) {
        return heldUnavailable;
      }
      if (
        selectedScriptIds === undefined ||
        !scriptIdsEqual(selectedScriptIds, planScriptIds(planBefore))
      ) {
        return heldUnavailable;
      }
      const threadShell = yield* snapshotQuery.getThreadShellById(input.threadId);
      if (Option.isNone(threadShell)) {
        return heldUnavailable;
      }
      const previewBefore = yield* provider.previewSubmissionRoute({
        threadId: input.sendTurn.threadId,
        input: input.sendTurn.input,
        modelSelection: input.sendTurn.modelSelection,
        interactionMode: input.sendTurn.interactionMode,
      });
      // The first route's own actual instance must already be the intended one
      // before any of its facts are used.
      if (
        previewBefore === undefined ||
        previewBefore.routePreview === undefined ||
        previewBefore.providerInstanceId !== input.intendedProviderInstanceId
      ) {
        return heldUnavailable;
      }
      const currentBefore = yield* decodeProjectSkillEnvironment({
        platform: planBefore.platform,
        arch: planBefore.arch,
        envSha256: planBefore.envSha256,
        checkCommands: planBefore.planned,
        providerDriverKind: previewBefore.driverKind,
        nativeSkillInventorySha256: null,
        scope: "managed-procedure/v1",
        routeConfigSha256: previewBefore.routePreview.routeConfigSha256,
      }).pipe(Effect.catchCause(planLookupFailed));
      if (currentBefore === undefined) {
        return heldUnavailable;
      }
      const planKeyBefore = planIdentityKey(planBefore);
      const previewKeyBefore = previewIdentityKey(previewBefore);
      const incarnationKeyBefore = incarnationBefore.value.sequence;

      const incarnationAfter = yield* resolveLatestThreadIncarnation(input.threadId);
      if (
        Option.isNone(incarnationAfter) ||
        incarnationAfter.value.sequence !== incarnationKeyBefore ||
        incarnationAfter.value.projectId !== identity.projectId
      ) {
        return heldUnavailable;
      }
      const planAfter = yield* selectedChecks
        .resolveTargetPlan({
          threadId: input.threadId,
          scriptIds: runScriptIds,
        })
        .pipe(Effect.catchCause(planLookupFailed));
      if (planAfter === undefined || planIdentityKey(planAfter) !== planKeyBefore) {
        return heldUnavailable;
      }
      if (
        selectedScriptIds === undefined ||
        !scriptIdsEqual(selectedScriptIds, planScriptIds(planAfter))
      ) {
        return heldUnavailable;
      }
      const previewAfter = yield* provider.previewSubmissionRoute({
        threadId: input.sendTurn.threadId,
        input: input.sendTurn.input,
        modelSelection: input.sendTurn.modelSelection,
        interactionMode: input.sendTurn.interactionMode,
      });
      if (previewIdentityKey(previewAfter) !== previewKeyBefore) {
        return heldUnavailable;
      }

      const frozenPreview = {
        providerInstanceId: input.intendedProviderInstanceId,
        driverKind: previewBefore.driverKind,
        routePreview: previewBefore.routePreview,
      };
      let successorToken: ProjectSkillMutationToken | undefined;
      let enteredDelivery: ProjectSkillTrialDeliveryEntered | undefined;

      const handoff: ProviderSkillTrialHandoff = {
        providerInstanceId: input.intendedProviderInstanceId,
        enter: (routed) =>
          Effect.gen(function* () {
            if (
              routed.providerInstanceId !== frozenPreview.providerInstanceId ||
              routed.driverKind !== frozenPreview.driverKind ||
              routed.routePreview === undefined ||
              routed.routePreview.sessionGeneration !==
                frozenPreview.routePreview.sessionGeneration ||
              routed.routePreview.nativeSessionId !== frozenPreview.routePreview.nativeSessionId ||
              routed.routePreview.routeConfigSha256 !== frozenPreview.routePreview.routeConfigSha256
            ) {
              return false;
            }
            const claimResult = yield* mutationFence
              .withUseClaimMutation(
                identity.projectId,
                Effect.flatMap(nowIso, (now) =>
                  trials.claimUseDelivery({
                    threadId: identity.threadId,
                    messageId: identity.messageId,
                    projectId: identity.projectId,
                    ref: identity.ref,
                    inputEventSequence: identity.inputEventSequence,
                    admittedSkillStateSeq: identity.admittedSkillStateSeq,
                    expectedStateSeq: identity.admittedSkillStateSeq,
                    current: currentBefore,
                    currentSelectedScriptIds: selectedScriptIds,
                    now,
                  }),
                ),
                {
                  expect: t0,
                  definiteEntered: (outcome) => outcome.status === "entered",
                },
              )
              .pipe(
                Effect.catchIf(
                  (error): error is ProjectSkillMutationFenceStaleExpect =>
                    error instanceof ProjectSkillMutationFenceStaleExpect,
                  () =>
                    Effect.succeed({
                      value: { status: "ref-changed" } as const,
                      successor: undefined,
                    }),
                ),
                Effect.catchCause((cause) =>
                  Cause.hasInterrupts(cause)
                    ? Effect.failCause(cause)
                    : Effect.succeed({
                        value: { status: "ref-changed" } as const,
                        successor: undefined,
                      }),
                ),
              );
            if (claimResult.value.status !== "entered" || claimResult.successor === undefined) {
              return false;
            }
            successorToken = claimResult.successor;
            const expectedBlock = yield* expectedBlockFor(identity.ref, "use").pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.succeed(Option.none<string>()),
              ),
            );
            if (Option.isNone(expectedBlock)) {
              return false;
            }
            enteredDelivery = {
              _tag: "Entered",
              identity,
              attemptToken: claimResult.value.attemptToken,
              expectedBlock: expectedBlock.value,
            };
            input.onEntered?.(enteredDelivery, {
              providerInstanceId: routed.providerInstanceId,
              driverKind: routed.driverKind,
            });
            return true;
          }),
        verifyUse: (observed) => {
          if (successorToken === undefined || !mutationFence.holds(successorToken)) {
            return false;
          }
          if (
            observed.providerInstanceId !== frozenPreview.providerInstanceId ||
            observed.driverKind !== frozenPreview.driverKind
          ) {
            return false;
          }
          const candidate = observed.submissionCandidate;
          if (candidate === undefined) return false;
          if (candidate.routeConfigSha256 !== frozenPreview.routePreview.routeConfigSha256) {
            return false;
          }
          if (
            observed.nativeSessionId !== frozenPreview.routePreview.nativeSessionId ||
            observed.sessionGeneration !== frozenPreview.routePreview.sessionGeneration
          ) {
            return false;
          }
          if (enteredDelivery === undefined) return false;
          return Option.isSome(
            managedSendParts({
              entered: enteredDelivery,
              providerDriverKind: observed.driverKind,
              providerInstanceId: observed.providerInstanceId,
              submission: observed,
            }),
          );
        },
      };
      return { _tag: "Handoff", handoff } satisfies ProjectSkillTrialUseHandoffOutcome;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.succeed(heldUnavailable),
      ),
    );

  return { resolveInput, claim, settle, useHandoff } satisfies ProjectSkillTrialDeliveryService;
});

/**
 * Requirements stay the shared SqlClient and the trial repository so one
 * client binds gate, delivery, and both repositories in the composition.
 */
export const layer = Layer.effect(ProjectSkillTrialDelivery, make).pipe(
  Layer.provide(NodeCrypto.layer),
);
