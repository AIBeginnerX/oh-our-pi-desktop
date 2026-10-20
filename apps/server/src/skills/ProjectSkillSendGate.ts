/**
 * ProjectSkillSendGate — the admission boundary between a turn-start and the
 * durable send path for managed `project-skill` context records (S4b).
 *
 * Two entry points share one decision:
 * - `preflight` runs the decision inside its own read transaction on the
 *   captured SqlClient. Nothing is written, so an `Admitted` stamp is
 *   advisory only and can never become durable state by itself.
 * - `authorizeInTransaction` runs the same decision inside the caller's
 *   already-open transaction on that same client — the fail-closed
 *   counterpart of the Trials `transact` nested-transaction refusal.
 *   Outside a transaction it answers `unavailable`.
 *
 * A send carrying no managed record is `Ordinary` and returns before any
 * SQL, repository, Crypto, or text inspection. Rejections fall into three
 * fixed reasons — `unavailable` (missing or deleted state, storage or
 * integrity failure), `unsupported` (a shape this slice will never admit),
 * and `not-admissible` (a well-formed request whose target fails policy).
 * A cause carrying any interrupt reason propagates with the interrupt
 * reasons only; every other failure or defect collapses to `unavailable`
 * and stays out of the result.
 *
 * This slice owns no writer: `claimDelivery`, `settleDelivery`, and
 * `sweepTrials` are deliberately untouched, and no provider or driver is
 * consulted. `use` intake is provisional — active ref, integrity, content
 * screen, message block, and durable script selection only; readiness,
 * environment, claim, and fence belong to later delivery storage.
 */
import {
  PROJECT_SKILL_CONTEXT_KIND,
  ProjectSkillContextPayload,
  canonicalProjectSkillContentJson,
  evaluateProjectSkillAdmission,
  renderProjectSkillBlock,
} from "@t3tools/contracts";
import type {
  ComposerContextRecord,
  MessageId,
  ProjectId,
  ProjectSkillContent,
  ProjectSkillVersionRef,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectSkillRepository } from "../persistence/ProjectSkills.ts";
import { ProjectSkillTrialRepository } from "../persistence/ProjectSkillTrials.ts";
import { screenProjectSkillContent } from "./skillContentScreen.ts";

export type ProjectSkillSendRejection = "unavailable" | "unsupported" | "not-admissible";

/** Fixed user-facing rejection copy: no ids, versions, hashes, or causes. */
export const PROJECT_SKILL_SEND_REJECTION_DETAIL: {
  readonly [R in ProjectSkillSendRejection]: string;
} = {
  unavailable: "The selected project skill cannot be sent with this request.",
  unsupported: "This message does not support project skill context.",
  "not-admissible": "The selected project skill cannot be sent.",
};

export interface ProjectSkillSendInput {
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly records: ReadonlyArray<ComposerContextRecord>;
  readonly bootstrap: boolean;
}

export type ProjectSkillSendDecision =
  | { readonly _tag: "Ordinary" }
  | {
      /**
       * Provisional structural intake: trial sends are admission-checked;
       * `use` is structurally admitted here (active ref, block, selection)
       * without claiming delivery readiness, environment, or claim rights.
       */
      readonly _tag: "Admitted";
      readonly projectId: ProjectId;
      readonly ref: ProjectSkillVersionRef;
      readonly admittedSkillStateSeq: number;
      readonly records: ReadonlyArray<ComposerContextRecord>;
    }
  | { readonly _tag: "Rejected"; readonly reason: ProjectSkillSendRejection };

export interface ProjectSkillSendGateService {
  readonly preflight: (input: ProjectSkillSendInput) => Effect.Effect<ProjectSkillSendDecision>;
  readonly authorizeInTransaction: (
    input: ProjectSkillSendInput,
  ) => Effect.Effect<ProjectSkillSendDecision>;
}

const managedRecordsOf = (records: ReadonlyArray<ComposerContextRecord>) =>
  records.filter((record) => record.kind === PROJECT_SKILL_CONTEXT_KIND);

/**
 * The fail-closed default: a send this composition never authorized is
 * ordinary when it carries no managed record and `unavailable` otherwise.
 * Never a substitute for the real gate on a composition that admits sends.
 */
const unavailableGate: ProjectSkillSendGateService = {
  preflight: (input) =>
    Effect.succeed(
      managedRecordsOf(input.records).length === 0
        ? ({ _tag: "Ordinary" } as const)
        : ({ _tag: "Rejected", reason: "unavailable" } as const),
    ),
  authorizeInTransaction: (input) =>
    Effect.succeed(
      managedRecordsOf(input.records).length === 0
        ? ({ _tag: "Ordinary" } as const)
        : ({ _tag: "Rejected", reason: "unavailable" } as const),
    ),
};

export class ProjectSkillSendGate extends Context.Reference<ProjectSkillSendGateService>(
  "t3/skills/ProjectSkillSendGate",
  { defaultValue: () => unavailableGate },
) {}

// The reserved memory kind is private inside shared/composerContextReferences.ts
// (PROJECT_MEMORY_REFERENCE_KIND) and is duplicated by value here on purpose.
const PROJECT_MEMORY_CONTEXT_KIND = "memory";

const decodePayload = Schema.decodeUnknownOption(ProjectSkillContextPayload);

const rejected = (reason: ProjectSkillSendRejection): ProjectSkillSendDecision => ({
  _tag: "Rejected",
  reason,
});

type SendClassification =
  | { readonly _tag: "Ordinary" }
  | { readonly _tag: "Rejected"; readonly reason: ProjectSkillSendRejection }
  | {
      readonly _tag: "Managed";
      readonly record: ComposerContextRecord;
      readonly payload: ProjectSkillContextPayload;
    };

/**
 * Structural classification only — `text` is never inspected and no SQL,
 * repository, or Crypto work happens here. A send with zero managed records
 * is `Ordinary`; the structural `unsupported` shapes (multiple managed
 * records, memory mixing, bootstrap) come next; only then is the surviving
 * payload decoded — a malformed payload is `not-admissible`.
 */
const classifySend = (input: ProjectSkillSendInput): SendClassification => {
  const managed = managedRecordsOf(input.records);
  if (managed.length === 0) return { _tag: "Ordinary" };
  if (managed.length > 1) return { _tag: "Rejected", reason: "unsupported" };
  if (input.records.some((record) => record.kind === PROJECT_MEMORY_CONTEXT_KIND)) {
    return { _tag: "Rejected", reason: "unsupported" };
  }
  if (input.bootstrap) return { _tag: "Rejected", reason: "unsupported" };
  const record = managed[0]!;
  const payload = decodePayload("payload" in record ? record.payload : undefined);
  if (Option.isNone(payload)) return { _tag: "Rejected", reason: "not-admissible" };
  if (payload.value.mode === "use" && payload.value.selectedScriptIds === undefined) {
    return { _tag: "Rejected", reason: "not-admissible" };
  }
  return { _tag: "Managed", record, payload: payload.value };
};

const countOccurrences = (text: string, needle: string): number =>
  needle === "" ? 0 : text.split(needle).length - 1;

const stampManagedRecord = (
  input: ProjectSkillSendInput,
  record: ComposerContextRecord,
  admitted: {
    readonly ref: ProjectSkillVersionRef;
    readonly mode: ProjectSkillContextPayload["mode"];
  },
  payload: ProjectSkillContextPayload,
  admittedSkillStateSeq: number,
): ReadonlyArray<ComposerContextRecord> =>
  input.records.map((candidate) =>
    candidate === record
      ? {
          ...candidate,
          payload: {
            ref: admitted.ref,
            mode: admitted.mode,
            admittedSkillStateSeq,
            ...(payload.selectedScriptIds !== undefined
              ? { selectedScriptIds: payload.selectedScriptIds }
              : {}),
          },
        }
      : candidate,
  );

const admittedDecision = (
  input: ProjectSkillSendInput,
  record: ComposerContextRecord,
  projectId: ProjectId,
  admitted: {
    readonly ref: ProjectSkillVersionRef;
    readonly mode: ProjectSkillContextPayload["mode"];
  },
  payload: ProjectSkillContextPayload,
  admittedSkillStateSeq: number,
): Extract<ProjectSkillSendDecision, { _tag: "Admitted" }> => ({
  _tag: "Admitted",
  projectId,
  ref: admitted.ref,
  admittedSkillStateSeq,
  records: stampManagedRecord(input, record, admitted, payload, admittedSkillStateSeq),
});

const sameRef = (a: ProjectSkillVersionRef, b: ProjectSkillVersionRef): boolean =>
  a.projectId === b.projectId &&
  a.skillId === b.skillId &&
  a.version === b.version &&
  a.contentSha256 === b.contentSha256;

// Same hex encoding as ProjectSkillService's private `toHex`; duplicated by
// value because that file is frozen.
const toHex = (bytes: Uint8Array): string => {
  const digits = "0123456789abcdef";
  let hex = "";
  for (const byte of bytes) hex += digits.charAt(byte >> 4) + digits.charAt(byte & 15);
  return hex;
};

/**
 * Same boundary policy as ProjectSkillService's `interruptOnly`: a cause
 * carrying any interrupt reason rethrows with the interrupt reasons only —
 * interruption is never turned into a decision and never drags
 * secret-bearing Fail/Die legs along.
 */
const interruptOnly = <E>(cause: Cause.Cause<E>) =>
  Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));

/**
 * The declared `never` error channel stays honest: a cause carrying any
 * interrupt reason exits interrupted with only interrupt reasons kept;
 * every other failure or defect becomes the fixed `unavailable` decision.
 * No SQL cause, payload, or path crosses into a decision, and nothing is
 * logged here.
 */
const sanitize = (
  effect: Effect.Effect<ProjectSkillSendDecision, unknown>,
): Effect.Effect<ProjectSkillSendDecision> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? interruptOnly(cause) : Effect.succeed(rejected("unavailable")),
    ),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const skills = yield* ProjectSkillRepository;
  const trials = yield* ProjectSkillTrialRepository;
  const crypto = yield* Crypto.Crypto;

  // Same canonical-hash policy as ProjectSkillService.verifyVersionSha: a
  // stored hash that disagrees with the canonical content bytes is an
  // integrity failure, not a readable record.
  const contentSha256 = (content: ProjectSkillContent) =>
    Effect.map(
      crypto.digest("SHA-256", new TextEncoder().encode(canonicalProjectSkillContentJson(content))),
      toHex,
    );

  /**
   * The shared admission decision — reads only. Every statement runs
   * through the captured SqlClient, so whichever transaction context the
   * caller installed (its own for `preflight`, the ambient one for
   * `authorizeInTransaction`) governs all of them, including the repository
   * reads that open savepoints. No claim, settle, sweep, or write method is
   * touched.
   */
  const decide = (
    input: ProjectSkillSendInput,
    record: ComposerContextRecord,
    payload: ProjectSkillContextPayload,
  ): Effect.Effect<ProjectSkillSendDecision, unknown> =>
    Effect.gen(function* () {
      // The send binds the live thread's live project.
      const threadRows = yield* sql<{ readonly projectId: ProjectId }>`
        SELECT t.project_id AS "projectId"
        FROM projection_threads t
        JOIN projection_projects p
          ON p.project_id = t.project_id AND p.deleted_at IS NULL
        WHERE t.thread_id = ${input.threadId} AND t.deleted_at IS NULL
      `;
      const projectId = threadRows[0]?.projectId;
      if (projectId === undefined) return rejected("unavailable");

      // The decider reuses a stored message by messageId, so a pre-appended
      // message event under this id is never re-admitted with managed items.
      const sent = yield* sql`
        SELECT 1 FROM orchestration_events
        WHERE aggregate_kind = 'thread' AND stream_id = ${input.threadId}
          AND event_type = 'thread.message-sent'
          AND json_extract(payload_json, '$.messageId') = ${input.messageId}
        LIMIT 1
      `;
      if (sent.length > 0) return rejected("unsupported");

      if (payload.ref.projectId !== projectId) return rejected("not-admissible");

      const detail = yield* skills.getSkill({ projectId, skillId: payload.ref.skillId });
      if (Option.isNone(detail)) return rejected("not-admissible");
      const version = detail.value.versions.find((candidate) =>
        sameRef(candidate.ref, payload.ref),
      );
      if (version === undefined) return rejected("not-admissible");

      // Integrity first: the selected stored content must rehash to its own
      // stored ref before it can authorize anything.
      if ((yield* contentSha256(version.content)) !== version.ref.contentSha256) {
        return rejected("unavailable");
      }
      if (screenProjectSkillContent(version.content).length > 0) {
        return rejected("not-admissible");
      }

      if (payload.mode === "use") {
        if (version.state !== "active") {
          return rejected("not-admissible");
        }
        const block = renderProjectSkillBlock({
          ref: version.ref,
          content: version.content,
          mode: "use",
        });
        if (countOccurrences(input.text, block) !== 1) {
          return rejected("not-admissible");
        }
        const admittedSkillStateSeq = yield* trials.stateSequence({ projectId });
        return admittedDecision(
          input,
          record,
          projectId,
          { ref: version.ref, mode: "use" },
          payload,
          admittedSkillStateSeq,
        );
      }

      const evaluation = evaluateProjectSkillAdmission({
        projectId,
        messageText: input.text,
        items: [
          {
            contextId: record.contextId,
            payload: "payload" in record ? record.payload : undefined,
          },
        ],
        versions: detail.value.versions.map((candidate) => ({
          ref: candidate.ref,
          state: candidate.state,
          content: candidate.content,
          // Trial admission never consults use readiness; do not fabricate ready.
          useReadiness: { ready: false, gaps: [] },
        })),
      });
      if (!evaluation.ok || evaluation.admitted[0] === undefined) {
        return rejected("not-admissible");
      }
      const admitted = evaluation.admitted[0];
      const admittedSkillStateSeq = yield* trials.stateSequence({ projectId });

      return admittedDecision(input, record, projectId, admitted, payload, admittedSkillStateSeq);
    });

  const preflight: ProjectSkillSendGateService["preflight"] = (input) => {
    const classification = classifySend(input);
    if (classification._tag !== "Managed") {
      return Effect.succeed(classification);
    }
    // The whole decision runs in one snapshot on the captured client.
    return sanitize(
      sql.withTransaction(decide(input, classification.record, classification.payload)),
    );
  };

  const authorizeInTransaction: ProjectSkillSendGateService["authorizeInTransaction"] = (input) => {
    const classification = classifySend(input);
    if (classification._tag !== "Managed") {
      return Effect.succeed(classification);
    }
    // The caller must already hold this client's transaction; nested
    // transactions are refused rather than opened.
    return sanitize(
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (active) =>
        Option.isSome(active)
          ? decide(input, classification.record, classification.payload)
          : Effect.succeed(rejected("unavailable")),
      ),
    );
  };

  return { preflight, authorizeInTransaction } satisfies ProjectSkillSendGateService;
});

/**
 * The Crypto implementation is universal, not client-bound; the SqlClient and
 * both repositories stay requirements so one shared client binds all three.
 */
export const layer = Layer.effect(ProjectSkillSendGate, make).pipe(Layer.provide(NodeCrypto.layer));
