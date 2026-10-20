/**
 * ProjectSkillService - the service boundary over the inactive project-skill
 * candidate store.
 *
 * It owns what the repository deliberately does not: content screening, the
 * live thread/selected-checks reads that `evaluateSkillSource` turns into the
 * authoritative `ProjectSkillCheckObservation`, generated skill and judgment
 * ids, timestamps, and the canonical content hash. The client supplies only
 * the three `expected` receipt identifiers — never an observation, hash, id,
 * or timestamp — and the event store's guarded write remains the final
 * authority on whether that source claim holds. `deriveDraft` previews the
 * review seed an accepted, completed source turn offers, read-only and
 * screened before it is shown; a derived `createCandidate` re-resolves that
 * exact source inside the store's insert transaction, so the preview is never
 * authority. On reads every returned
 * version's canonical content is re-hashed before it is exposed and a
 * mismatch fails closed, and judgments group by their exact version ref so a
 * revision never inherits them.
 *
 * `get` additionally sweeps each requested version's trial history through the
 * injected trial repository (same SqlClient, one scoped transaction per ref).
 * A server whose composition has no trial repository — or a version whose
 * sweep fails for a non-interrupt reason — reports history-unavailable by
 * omitting `trials`; `[]` is reserved for a history that was actually read
 * and found empty.
 *
 * Public failures are the typed contract errors only: fixed rejection
 * reasons, conflict, not-found, and one fixed `ProjectSkillStoreError`
 * message. SQL causes, receipt payloads, content text, and paths never leave
 * this boundary. Use and admission remain closed; activate/retire route
 * through the shared mutation fence and pinned provider preview only, and
 * activation additionally requires the boot `ProjectSkillUsePolicy` to allow
 * the previewed driver. Retire, judgments, and withdrawal are not gated.
 *
 * @module skills/ProjectSkillService
 */
import {
  canonicalProjectSkillContentJson,
  CommandId,
  evaluateSkillSource,
  EventId,
  IsoDateTime,
  OrchestrationAggregateKind,
  OrchestrationEvent,
  OrchestrationEventMetadata,
  OrchestrationEventType,
  ProjectId,
  ProjectSkillEnvironment,
  ProjectSkillId,
  ProjectSkillJudgment,
  ProjectSkillJudgmentId,
  ProjectSkillStoreConflictError,
  ProjectSkillStoreError,
  ProjectSkillStoreNotFoundError,
  ProjectSkillStoreRejectedError,
  RecordProjectSkillJudgmentInput,
  SelectedChecksThreadNotFoundError,
  ThreadId,
} from "@t3tools/contracts";
import type {
  ActivateProjectSkillInput,
  CreateProjectSkillCandidateInput,
  DeleteProjectSkillInput,
  DeriveProjectSkillReviewDraftInput,
  DeriveProjectSkillReviewDraftResult,
  GetProjectSkillInput,
  ListProjectSkillsInput,
  ProjectSkillContent,
  ProjectSkillDetail,
  ProjectSkillExpectedCheckTuple,
  ProjectSkillJudgmentRecord,
  ProjectSkillListResult,
  ProjectSkillSummary,
  ProjectSkillTrialSummary,
  ProjectSkillTransitionResult,
  ProjectSkillVersionRecord,
  ProjectSkillVersionRef,
  ProjectSkillVersionView,
  RetireProjectSkillInput,
  ReviseProjectSkillInput,
  WithdrawProjectSkillJudgmentInput,
} from "@t3tools/contracts";
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
import { ProviderService } from "../provider/Services/ProviderService.ts";
import {
  ProjectSkillRepository,
  type ProjectSkillDeleteOutcome,
  type ProjectSkillTransitionOutcome,
  type ProjectSkillWithdrawOutcome,
} from "../persistence/ProjectSkills.ts";
import {
  ProjectSkillTrialRepository,
  type ProjectSkillTrialRow,
} from "../persistence/ProjectSkillTrials.ts";
import type { SelectedChecksTargetPlan } from "../selectedChecks/SelectedChecks.ts";
import { SelectedChecks } from "../selectedChecks/SelectedChecks.ts";
import {
  ProjectSkillMutationFence,
  ProjectSkillMutationFenceStaleExpect,
  type ProjectSkillMutationToken,
} from "./ProjectSkillMutationFence.ts";
import { ProjectSkillUsePolicy } from "./ProjectSkillUsePolicy.ts";
import { screenProjectSkillContent } from "./skillContentScreen.ts";

/** The one message any store or integrity failure surfaces; causes stay internal. */
const storeFailure = () =>
  new ProjectSkillStoreError({
    message: "project-skill store operation failed",
  });

const toHex = (bytes: Uint8Array): string => {
  const digits = "0123456789abcdef";
  let hex = "";
  for (const byte of bytes) hex += digits.charAt(byte >> 4) + digits.charAt(byte & 15);
  return hex;
};

/**
 * The dependency boundary inspects the original cause exactly once. A cause
 * that carries any interrupt reason rethrows with the interrupt reasons
 * only — interruption is never turned into a store failure or a success and
 * never drags secret-bearing Fail/Die legs along. Everything else collapses
 * to the fixed store failure, so no SQL cause, path, or payload crosses.
 */
const interruptOnly = <E>(cause: Cause.Cause<E>) =>
  Effect.failCause(Cause.fromReasons<never>(cause.reasons.filter(Cause.isInterruptReason)));

const guarded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause) ? interruptOnly(cause) : Effect.fail(storeFailure()),
    ),
  );

/** A judgment binds only the version whose full four-field ref it names. */
const refKey = (ref: ProjectSkillVersionRef): string =>
  JSON.stringify([ref.projectId, ref.skillId, ref.version, ref.contentSha256]);

const decodeJudgmentInput = Schema.decodeUnknownEffect(RecordProjectSkillJudgmentInput);
const decodeProjectSkillJudgment = Schema.decodeUnknownEffect(ProjectSkillJudgment);
const decodeProjectSkillEnvironment = Schema.decodeUnknownEffect(ProjectSkillEnvironment);

const ACTIVATION_PREVIEW_INPUT = "project-skill-activation-route-preview";

const NonNegativeInt = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

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

const rowToEvent = (row: unknown): Option.Option<{ readonly event: OrchestrationEvent }> => {
  const rowExit = decodePersistedRow(row);
  if (Exit.isFailure(rowExit)) return Option.none();
  const eventExit = decodePersistedEvent(rowExit.value);
  if (Exit.isFailure(eventExit)) return Option.none();
  return Option.some({ event: eventExit.value });
};

type ThreadIncarnationAnchor = {
  readonly sequence: number;
  readonly projectId: ProjectId;
};

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
        routePreview: route.routePreview ?? null,
      });

const mapTransitionOutcome = (
  outcome: ProjectSkillTransitionOutcome,
): Effect.Effect<
  ProjectSkillTransitionResult,
  ProjectSkillStoreNotFoundError | ProjectSkillStoreRejectedError
> => {
  switch (outcome.status) {
    case "applied":
      return Effect.succeed({ stateSeq: outcome.stateSeq });
    case "not-found":
      return Effect.fail(new ProjectSkillStoreNotFoundError({}));
    case "project-missing":
      return Effect.fail(new ProjectSkillStoreRejectedError({ reason: "project-missing" }));
    case "state-changed":
      return Effect.fail(new ProjectSkillStoreRejectedError({ reason: "state-changed" }));
    case "state-invalid":
      return Effect.fail(new ProjectSkillStoreRejectedError({ reason: "state-invalid" }));
    case "not-ready":
      return Effect.fail(
        new ProjectSkillStoreRejectedError({
          reason: "not-ready",
          gaps: [...outcome.gaps],
        }),
      );
  }
};

/** Preserves typed store rejections; collapses only unknown dependency failures. */
const activationDependency = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProjectSkillStoreError | ProjectSkillStoreRejectedError, R> =>
  effect.pipe(
    Effect.catchCause(
      (cause): Effect.Effect<never, ProjectSkillStoreError | ProjectSkillStoreRejectedError> => {
        if (Cause.hasInterrupts(cause)) return interruptOnly(cause);
        const error = Cause.findErrorOption(cause);
        if (Option.isSome(error) && error.value instanceof ProjectSkillStoreRejectedError) {
          return Effect.fail(error.value);
        }
        return Effect.fail(storeFailure());
      },
    ),
  );

/**
 * Stored trial row → wire summary. `window` alone decides which observation
 * fields exist: `open` carries the provisional snapshot only (never eligible
 * evidence), `closed` the frozen in-range observations plus the once-computed
 * uncounted total, `thread-recreated` none. Repository-internal fields —
 * incarnation, tombstone, attempt token, inventory — never cross, and
 * `sameThreadAsSource` reads the version's own lineage, not the row.
 */
const trialSummary = (
  row: ProjectSkillTrialRow,
  source: ProjectSkillVersionRecord["source"],
): ProjectSkillTrialSummary => {
  const sourceThreadId =
    source.type === "work" ? source.check.threadId : source.root.check.threadId;
  const base = {
    threadId: row.threadId,
    messageId: row.messageId,
    inputEventSequence: row.inputEventSequence,
    admittedSkillStateSeq: row.admittedSkillStateSeq,
    delivery: row.delivery,
    providerDriverKind: row.providerDriverKind,
    sameThreadAsSource: row.threadId === sourceThreadId,
  };
  switch (row.window) {
    case "open":
      return {
        ...base,
        window: "open",
        provisionalObservations: row.provisional.map((attempt) => ({
          attemptId: attempt.attemptId,
          receiptSequence: attempt.receiptSequence,
          outcome: attempt.outcome,
          endedAt: attempt.endedAt,
        })),
      };
    case "closed":
      return {
        ...base,
        window: "closed",
        observations: row.observations.map((observation) => ({
          evidenceId: observation.evidenceId,
          attemptId: observation.attemptId,
          receiptSequence: observation.receiptSequence,
          outcome: observation.outcome,
          endedAt: observation.endedAt,
        })),
        uncountedAttempts: row.uncountedAttempts,
      };
    case "thread-recreated":
      return { ...base, window: "thread-recreated" };
  }
};

export class ProjectSkillService extends Context.Service<
  ProjectSkillService,
  {
    /**
     * Read-only preview of the review draft a passed, accepted source can
     * seed: the bounded partial fields (screened, with no invented
     * exclusion), their truncation flags, and the pinned source identity —
     * or why none is available. It writes nothing; saving stays the explicit
     * `createCandidate`.
     */
    readonly deriveDraft: (
      input: DeriveProjectSkillReviewDraftInput,
    ) => Effect.Effect<
      DeriveProjectSkillReviewDraftResult,
      ProjectSkillStoreRejectedError | ProjectSkillStoreError
    >;
    /** Save a new inactive candidate from a passed selected-checks source. */
    readonly createCandidate: (
      input: CreateProjectSkillCandidateInput,
    ) => Effect.Effect<
      ProjectSkillVersionView,
      ProjectSkillStoreRejectedError | ProjectSkillStoreError
    >;
    /** Append a new version; a stale `expectedLatestVersion` is a conflict. */
    readonly revise: (
      input: ReviseProjectSkillInput,
    ) => Effect.Effect<
      ProjectSkillVersionView,
      | ProjectSkillStoreRejectedError
      | ProjectSkillStoreConflictError
      | ProjectSkillStoreNotFoundError
      | ProjectSkillStoreError
    >;
    /** Latest version per skill for the project. */
    readonly listSkills: (
      input: ListProjectSkillsInput,
    ) => Effect.Effect<ProjectSkillListResult, ProjectSkillStoreError>;
    /**
     * Every version latest-first with each version's own ref-bound judgments
     * and its scoped trial history; `trials` is absent when the history could
     * not be read, never `[]` for a failed read.
     */
    readonly get: (
      input: GetProjectSkillInput,
    ) => Effect.Effect<ProjectSkillDetail, ProjectSkillStoreNotFoundError | ProjectSkillStoreError>;
    /**
     * Record one rights/review judgment against an exact version ref. The
     * input is raw: only `rights`/`review` bodies may decode, and every other
     * kind is the fixed `judgment-kind-unavailable` rejection — the reason
     * this method alone takes `unknown` instead of the decoded input type.
     */
    readonly recordJudgment: (
      input: unknown,
    ) => Effect.Effect<
      ProjectSkillJudgmentRecord,
      ProjectSkillStoreRejectedError | ProjectSkillStoreError
    >;
    /** One-way withdrawal of a recorded judgment; the card's status result is kept. */
    readonly withdrawJudgment: (
      input: WithdrawProjectSkillJudgmentInput,
    ) => Effect.Effect<ProjectSkillWithdrawOutcome, ProjectSkillStoreError>;
    /** Hard delete of the whole skill's versions and judgments. */
    readonly deleteSkill: (
      input: DeleteProjectSkillInput,
    ) => Effect.Effect<ProjectSkillDeleteOutcome, ProjectSkillStoreError>;
    /** Activate or restore one exact version against a server-resolved target. */
    readonly activate: (
      input: ActivateProjectSkillInput,
    ) => Effect.Effect<
      ProjectSkillTransitionResult,
      ProjectSkillStoreRejectedError | ProjectSkillStoreNotFoundError | ProjectSkillStoreError
    >;
    /** Retire one active exact version. */
    readonly retire: (
      input: RetireProjectSkillInput,
    ) => Effect.Effect<
      ProjectSkillTransitionResult,
      ProjectSkillStoreRejectedError | ProjectSkillStoreNotFoundError | ProjectSkillStoreError
    >;
  }
>()("t3/skills/ProjectSkillService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* ProjectSkillRepository;
  const trialRepository = yield* Effect.serviceOption(ProjectSkillTrialRepository);
  const selectedChecks = yield* SelectedChecks;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const provider = yield* ProviderService;
  const usePolicy = yield* ProjectSkillUsePolicy;
  const mutationFence = yield* ProjectSkillMutationFence;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const mutateProject = <A, E, R>(
    projectId: ProjectId,
    effect: Effect.Effect<A, E, R>,
    options?: { readonly expect: ProjectSkillMutationToken },
  ): Effect.Effect<A, E | ProjectSkillMutationFenceStaleExpect, R> =>
    options === undefined
      ? mutationFence.withProjectMutation([projectId], effect)
      : mutationFence.withProjectMutation([projectId], effect, { expect: options.expect });

  const resolveLatestThreadIncarnation = (threadId: ThreadId) =>
    guarded(
      Effect.gen(function* () {
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
        const incarnationRows = yield* sql<Record<string, unknown>>`
          SELECT ${eventColumns}
          FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type = 'thread.created'
          ORDER BY sequence DESC
          LIMIT 1
        `;
        const incarnationRow = incarnationRows[0];
        if (incarnationRow === undefined) return Option.none<ThreadIncarnationAnchor>();
        const incarnationDecoded = rowToEvent(incarnationRow);
        if (Option.isNone(incarnationDecoded)) return Option.none<ThreadIncarnationAnchor>();
        const incarnation = incarnationDecoded.value.event;
        if (
          incarnation.type !== "thread.created" ||
          incarnation.aggregateKind !== "thread" ||
          incarnation.aggregateId !== threadId ||
          incarnation.payload.threadId !== threadId
        ) {
          return Option.none<ThreadIncarnationAnchor>();
        }
        const boundaryRows = yield* sql<{ readonly eventType: string | null }>`
          SELECT event_type AS "eventType"
          FROM orchestration_events
          WHERE aggregate_kind = 'thread' AND stream_id = ${threadId}
            AND event_type IN ('thread.created', 'thread.deleted')
            AND sequence > ${incarnation.sequence}
          ORDER BY sequence ASC
          LIMIT 1
        `;
        const boundary = boundaryRows[0]?.eventType;
        if (boundary === "thread.deleted" || boundary === "thread.created") {
          return Option.none<ThreadIncarnationAnchor>();
        }
        return Option.some({
          sequence: incarnation.sequence,
          projectId: incarnation.payload.projectId,
        });
      }),
    );

  const resolveTargetPlan = (input: {
    readonly threadId: ThreadId;
    readonly scriptIds: ReadonlyArray<string>;
  }) =>
    selectedChecks.resolveTargetPlan(input).pipe(
      Effect.catchTag("SelectedChecksThreadNotFoundError", () =>
        Effect.fail(new ProjectSkillStoreRejectedError({ reason: "thread-missing" })),
      ),
      Effect.catchTag("SelectedChecksRejectedError", () =>
        Effect.fail(new ProjectSkillStoreRejectedError({ reason: "target-unconfirmed" })),
      ),
    );

  const readProjectStateSeq = (projectId: ProjectId) =>
    Option.match(trialRepository, {
      onNone: () => Effect.succeed(Option.none<number>()),
      onSome: (repo) =>
        repo.stateSequence({ projectId }).pipe(
          Effect.map((stateSeq) => Option.some(stateSeq)),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? interruptOnly(cause) : Effect.fail(storeFailure()),
          ),
        ),
    });

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const contentSha256 = (content: ProjectSkillContent) =>
    guarded(
      Effect.map(
        crypto.digest(
          "SHA-256",
          new TextEncoder().encode(canonicalProjectSkillContentJson(content)),
        ),
        toHex,
      ),
    );
  const generatedId = (prefix: string) =>
    guarded(Effect.map(crypto.randomUUIDv4, (uuid) => `${prefix}${uuid.replaceAll("-", "")}`));

  // A stored hash that disagrees with the canonical bytes is an integrity
  // failure, not a readable record — fail closed before it is exposed.
  const verifyVersionSha = (record: ProjectSkillVersionRecord) =>
    Effect.flatMap(contentSha256(record.content), (sha256) =>
      sha256 === record.ref.contentSha256 ? Effect.succeed(record) : Effect.fail(storeFailure()),
    );

  /** `rightsRecorded`/`reviewRecorded` count unwithdrawn judgments of this exact ref only. */
  const versionView = (
    record: ProjectSkillVersionRecord,
    judgments: ReadonlyArray<ProjectSkillJudgmentRecord>,
  ) =>
    Effect.map(verifyVersionSha(record), (version) => {
      // The full ref key is the boundary: a same-version/same-hash row from
      // another project or skill never attaches here, withdrawn or not.
      const key = refKey(version.ref);
      const bound = judgments.filter((row) => refKey(row.judgment.ref) === key);
      return {
        version,
        judgments: bound,
        rightsRecorded: bound.some(
          (row) => row.withdrawnAt === null && row.judgment.kind === "rights",
        ),
        reviewRecorded: bound.some(
          (row) => row.withdrawnAt === null && row.judgment.kind === "review",
        ),
      };
    });

  /**
   * One version's scoped trial history. `None` answers both sanctioned
   * absences: a composition without the trial repository, or a sweep that
   * fails for a non-interrupt reason — the caller then leaves `trials` off the
   * view, which the wire contract reads as history-unavailable, distinct from
   * a genuinely empty `[]`. Interrupts are rethrown through the same
   * interrupt-only filter every other dependency uses, so a mixed cause still
   * exits as interruption and never as success or a store error.
   */
  const trialHistoryFor = (ref: ProjectSkillVersionRef, now: string) =>
    Option.isNone(trialRepository)
      ? Effect.succeed(Option.none<ReadonlyArray<ProjectSkillTrialRow>>())
      : guarded(
          mutateProject(
            ref.projectId,
            trialRepository.value.sweepTrials({ projectId: ref.projectId, ref, now }),
          ),
        ).pipe(
          Effect.map((result) => Option.some(result.items)),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? interruptOnly(cause)
              : Effect.succeed(Option.none<ReadonlyArray<ProjectSkillTrialRow>>()),
          ),
        );

  const sweepFailedUseHoldsFor = (ref: ProjectSkillVersionRef, now: string) =>
    guarded(mutateProject(ref.projectId, repository.sweepFailedUseHolds({ ref, now })));

  /**
   * The preflight derive and create share: a live thread in the named
   * project, the thread's selected-check view, and the pure source policy
   * over them. `measure` also asks for the current-workspace measurement a
   * derived draft judges acceptance on; manual saves keep the unmeasured
   * read they always had.
   */
  const prepareSource = Effect.fnUntraced(function* (
    input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly expected: ProjectSkillExpectedCheckTuple;
    },
    measure: boolean,
  ) {
    const threadShell = yield* guarded(snapshotQuery.getThreadShellById(input.threadId));
    if (Option.isNone(threadShell) || threadShell.value.projectId !== input.projectId) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "thread-missing" });
    }
    const shell = threadShell.value;
    // A real SelectedChecks read can die on an internal projection defect;
    // the typed not-found stays the fixed thread-missing rejection while any
    // other failure shape collapses into the fixed store error. Interrupts
    // are inspected before either replacement so a mixed cause stays an
    // interrupt.
    const checks = yield* (
      measure
        ? selectedChecks.get(input.threadId, { measureCurrent: true })
        : selectedChecks.get(input.threadId)
    ).pipe(
      Effect.catchCause(
        (cause): Effect.Effect<never, ProjectSkillStoreError | ProjectSkillStoreRejectedError> => {
          if (Cause.hasInterrupts(cause)) return interruptOnly(cause);
          if (Cause.hasDies(cause)) return Effect.fail(storeFailure());
          const error = Cause.findErrorOption(cause);
          return Option.isSome(error) && error.value instanceof SelectedChecksThreadNotFoundError
            ? Effect.fail(new ProjectSkillStoreRejectedError({ reason: "thread-missing" }))
            : Effect.fail(storeFailure());
        },
      ),
    );
    const latestInputEventSequence = yield* guarded(
      repository.latestUserInputSequence({ threadId: input.threadId }),
    );
    const evaluation = yield* guarded(
      Effect.try(() =>
        evaluateSkillSource({
          candidateProjectId: input.projectId,
          thread: {
            threadId: input.threadId,
            projectId: shell.projectId,
            worktreePath: shell.worktreePath,
            latestTurnState: shell.latestTurn?.state ?? null,
          },
          latestInputEventSequence,
          checks,
          expected: input.expected,
        }),
      ),
    );
    if (!evaluation.ok) {
      return yield* new ProjectSkillStoreRejectedError({
        reason: "source-ineligible",
        sourceReason: evaluation.reason,
      });
    }
    return { check: evaluation.check, checks } as const;
  });

  const deriveDraft = Effect.fn("ProjectSkillService.deriveDraft")(function* (
    input: DeriveProjectSkillReviewDraftInput,
  ) {
    const source = yield* prepareSource(input, true);
    const derived = yield* guarded(
      repository.deriveDraft({
        projectId: input.projectId,
        check: source.check,
        measured: source.checks,
      }),
    );
    if (derived.status === "unavailable") return derived;
    // Text from a thread is untrusted data: the seed is screened over exactly
    // the fields it carries before a review form may show it, and a rejected
    // seed surfaces only the fixed reasons. The exclusion is never invented
    // for the screen — it stays absent until the user writes it.
    const screenReasons = yield* guarded(
      Effect.try(() => screenProjectSkillContent(derived.partial)),
    );
    if (screenReasons.length > 0) {
      return yield* new ProjectSkillStoreRejectedError({
        reason: "screen",
        screenReasons: [...screenReasons],
      });
    }
    return derived;
  });

  const createCandidate = Effect.fn("ProjectSkillService.createCandidate")(function* (
    input: CreateProjectSkillCandidateInput,
  ) {
    const screenReasons = yield* guarded(
      Effect.try(() => screenProjectSkillContent(input.content)),
    );
    if (screenReasons.length > 0) {
      return yield* new ProjectSkillStoreRejectedError({
        reason: "screen",
        screenReasons: [...screenReasons],
      });
    }
    const source = yield* prepareSource(input, input.draft.type === "derived");
    const skillId = ProjectSkillId.make(yield* generatedId("psk_"));
    const sha = yield* contentSha256(input.content);
    const now = yield* nowIso;
    // A derived draft's source is re-resolved by the store inside its own
    // insert transaction; the measurement is the one input storage cannot
    // redo, so it rides along from this preflight.
    const outcome = yield* guarded(
      mutateProject(
        input.projectId,
        repository.insertCandidate({
          skillId,
          projectId: input.projectId,
          content: input.content,
          contentSha256: sha,
          check: source.check,
          draft: input.draft,
          ...(input.draft.type === "derived" ? { measured: source.checks } : {}),
          now,
        }),
      ),
    );
    if (outcome.status === "applied") return yield* versionView(outcome.row, []);
    if (outcome.status === "duplicate-content") {
      return yield* new ProjectSkillStoreRejectedError({
        reason: "duplicate-content",
        existingVersion: outcome.existingVersion,
      });
    }
    return yield* new ProjectSkillStoreRejectedError({ reason: outcome.status });
  });

  const revise = Effect.fn("ProjectSkillService.revise")(function* (
    input: ReviseProjectSkillInput,
  ) {
    const screenReasons = yield* guarded(
      Effect.try(() => screenProjectSkillContent(input.content)),
    );
    if (screenReasons.length > 0) {
      return yield* new ProjectSkillStoreRejectedError({
        reason: "screen",
        screenReasons: [...screenReasons],
      });
    }
    const sha = yield* contentSha256(input.content);
    const now = yield* nowIso;
    const outcome = yield* guarded(
      mutateProject(
        input.projectId,
        repository.insertRevision({
          projectId: input.projectId,
          skillId: input.skillId,
          fromVersion: input.fromVersion,
          expectedLatestVersion: input.expectedLatestVersion,
          content: input.content,
          contentSha256: sha,
          now,
        }),
      ),
    );
    if (outcome.status === "applied") return yield* versionView(outcome.row, []);
    if (outcome.status === "not-found") return yield* new ProjectSkillStoreNotFoundError({});
    if (outcome.status === "conflict") {
      return yield* new ProjectSkillStoreConflictError({
        currentLatestVersion: outcome.currentLatestVersion,
      });
    }
    if (outcome.status === "duplicate-content") {
      return yield* new ProjectSkillStoreRejectedError({
        reason: "duplicate-content",
        existingVersion: outcome.existingVersion,
      });
    }
    return yield* new ProjectSkillStoreRejectedError({ reason: "project-missing" });
  });

  const listSkills = Effect.fn("ProjectSkillService.listSkills")(function* (
    input: ListProjectSkillsInput,
  ) {
    const result = yield* guarded(
      repository.listSkills({ projectId: input.projectId, limit: input.limit }),
    );
    const items: Array<ProjectSkillSummary> = [];
    for (const item of result.items) {
      const version = yield* verifyVersionSha(item.version);
      const bound = item.judgments.filter(
        (row) => refKey(row.judgment.ref) === refKey(version.ref),
      );
      items.push({
        ref: version.ref,
        title: version.content.title,
        state: version.state,
        createdAt: version.createdAt,
        rightsRecorded: bound.some(
          (row) => row.withdrawnAt === null && row.judgment.kind === "rights",
        ),
        reviewRecorded: bound.some(
          (row) => row.withdrawnAt === null && row.judgment.kind === "review",
        ),
      });
    }
    return { items, truncated: result.truncated };
  });

  const get = Effect.fn("ProjectSkillService.get")(function* (input: GetProjectSkillInput) {
    const detail = yield* guarded(
      repository.getSkill({ projectId: input.projectId, skillId: input.skillId }),
    );
    if (Option.isNone(detail)) return yield* new ProjectSkillStoreNotFoundError({});
    const now = yield* nowIso;
    for (const record of detail.value.versions) {
      yield* sweepFailedUseHoldsFor(record.ref, now);
    }
    const judgmentsAfterSweep = new Map<string, Array<ProjectSkillJudgmentRecord>>();
    for (const row of detail.value.judgments) {
      const key = refKey(row.judgment.ref);
      const bucket = judgmentsAfterSweep.get(key);
      if (bucket === undefined) judgmentsAfterSweep.set(key, [row]);
      else bucket.push(row);
    }
    const versions: Array<ProjectSkillVersionView> = [];
    for (const record of detail.value.versions) {
      const view = yield* versionView(record, judgmentsAfterSweep.get(refKey(record.ref)) ?? []);
      const history = yield* trialHistoryFor(record.ref, now);
      versions.push(
        Option.isSome(history)
          ? {
              ...view,
              trials: history.value.map((row) => trialSummary(row, record.source)),
            }
          : view,
      );
    }
    const latest = detail.value.versions[0];
    if (latest === undefined) return yield* storeFailure();
    const stateSeq = yield* readProjectStateSeq(input.projectId);
    return {
      projectId: input.projectId,
      skillId: input.skillId,
      latestVersion: latest.ref.version,
      versions,
      ...(Option.isSome(stateSeq) ? { stateSeq: stateSeq.value } : {}),
    };
  });

  const recordJudgment = Effect.fn("ProjectSkillService.recordJudgment")(function* (
    input: unknown,
  ) {
    const decoded = yield* decodeJudgmentInput(input).pipe(
      Effect.catchCause(
        (cause): Effect.Effect<never, ProjectSkillStoreError | ProjectSkillStoreRejectedError> => {
          if (Cause.hasInterrupts(cause)) return interruptOnly(cause);
          if (Cause.hasDies(cause)) return Effect.fail(storeFailure());
          return Option.isSome(Cause.findErrorOption(cause))
            ? Effect.fail(
                new ProjectSkillStoreRejectedError({ reason: "judgment-kind-unavailable" }),
              )
            : Effect.fail(storeFailure());
        },
      ),
    );
    const judgmentId = ProjectSkillJudgmentId.make(yield* generatedId("psj_"));
    const recordedAt = yield* nowIso;
    // Server-owned fields are placed after the client body so nothing nested
    // can override them; the S1 union decode is the last gate on the stored
    // row and its Literal(true) review claims.
    const judgment = yield* guarded(
      decodeProjectSkillJudgment({
        ...decoded.judgment,
        judgmentId,
        ref: decoded.ref,
        recordedAt,
        recordedBy: "authenticated-client",
      }),
    );
    if (judgment.kind === "reproduction" || judgment.kind === "non-application") {
      const outcome = yield* guarded(
        mutateProject(decoded.ref.projectId, repository.insertEvidenceJudgment({ judgment })),
      );
      if (outcome.status === "applied") return outcome.row;
      if (outcome.status === "evidence-mismatch") {
        return yield* new ProjectSkillStoreRejectedError({ reason: "evidence-mismatch" });
      }
      if (outcome.status === "unsupported-kind") {
        return yield* new ProjectSkillStoreRejectedError({ reason: "judgment-kind-unavailable" });
      }
      return yield* new ProjectSkillStoreRejectedError({ reason: outcome.status });
    }
    if (judgment.kind !== "rights" && judgment.kind !== "review") {
      return yield* new ProjectSkillStoreRejectedError({ reason: "judgment-kind-unavailable" });
    }
    const outcome = yield* guarded(
      mutateProject(decoded.ref.projectId, repository.insertJudgment({ judgment })),
    );
    if (outcome.status === "applied") return outcome.row;
    return yield* new ProjectSkillStoreRejectedError({ reason: outcome.status });
  });

  const withdrawJudgment = Effect.fn("ProjectSkillService.withdrawJudgment")(function* (
    input: WithdrawProjectSkillJudgmentInput,
  ) {
    const now = yield* nowIso;
    return yield* guarded(
      mutateProject(
        input.ref.projectId,
        repository.withdrawJudgment({ ref: input.ref, judgmentId: input.judgmentId, now }),
      ),
    );
  });

  const deleteSkill = Effect.fn("ProjectSkillService.deleteSkill")(function* (
    input: DeleteProjectSkillInput,
  ) {
    return yield* guarded(
      mutateProject(
        input.projectId,
        repository.deleteSkill({
          projectId: input.projectId,
          skillId: input.skillId,
          expectedLatestVersion: input.expectedLatestVersion,
        }),
      ),
    );
  });

  const activate = Effect.fn("ProjectSkillService.activate")(function* (
    input: ActivateProjectSkillInput,
  ) {
    const token = mutationFence.acquire(input.ref.projectId);
    if (token === undefined) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    const lifecycleBefore = yield* guarded(repository.readLifecycle({ ref: input.ref }));
    if (Option.isNone(lifecycleBefore)) {
      return yield* new ProjectSkillStoreNotFoundError({});
    }
    if (lifecycleBefore.value.stateSeq !== input.expectedStateSeq) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    const incarnationBefore = yield* resolveLatestThreadIncarnation(input.target.threadId);
    if (Option.isNone(incarnationBefore)) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    if (incarnationBefore.value.projectId !== input.ref.projectId) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    const planBefore = yield* activationDependency(
      resolveTargetPlan({
        threadId: input.target.threadId,
        scriptIds: [...input.target.scriptIds],
      }),
    );
    if (planBefore.projectId !== input.ref.projectId) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "ref-mismatch" });
    }
    const threadShell = yield* guarded(snapshotQuery.getThreadShellById(input.target.threadId));
    if (Option.isNone(threadShell)) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "thread-missing" });
    }
    const sendInput = {
      threadId: input.target.threadId,
      input: ACTIVATION_PREVIEW_INPUT,
      modelSelection: threadShell.value.modelSelection,
      interactionMode:
        threadShell.value.interactionMode === "default"
          ? undefined
          : threadShell.value.interactionMode,
    };
    const previewBefore = yield* guarded(provider.previewSubmissionRoute(sendInput));
    if (previewBefore === undefined || previewBefore.routePreview === undefined) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "target-unconfirmed" });
    }
    // Backend admission authority: the boot policy gates the driver the
    // authoritative preview resolved, whatever the descriptor advertised.
    if (!usePolicy.allowsDriver(previewBefore.driverKind)) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "target-unconfirmed" });
    }
    const currentBefore = yield* guarded(
      decodeProjectSkillEnvironment({
        platform: planBefore.platform,
        arch: planBefore.arch,
        envSha256: planBefore.envSha256,
        checkCommands: planBefore.planned,
        providerDriverKind: previewBefore.driverKind,
        nativeSkillInventorySha256: null,
        scope: "managed-procedure/v1",
        routeConfigSha256: previewBefore.routePreview.routeConfigSha256,
      }),
    );
    const planKeyBefore = planIdentityKey(planBefore);
    const previewKeyBefore = previewIdentityKey(previewBefore);
    const incarnationKeyBefore = incarnationBefore.value.sequence;

    const incarnationAfter = yield* resolveLatestThreadIncarnation(input.target.threadId);
    if (
      Option.isNone(incarnationAfter) ||
      incarnationAfter.value.sequence !== incarnationKeyBefore ||
      incarnationAfter.value.projectId !== input.ref.projectId
    ) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    const planAfter = yield* activationDependency(
      resolveTargetPlan({
        threadId: input.target.threadId,
        scriptIds: [...input.target.scriptIds],
      }),
    );
    if (planIdentityKey(planAfter) !== planKeyBefore) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    const previewAfter = yield* guarded(provider.previewSubmissionRoute(sendInput));
    if (previewIdentityKey(previewAfter) !== previewKeyBefore) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    const transition = yield* mutateProject(
      input.ref.projectId,
      guarded(
        repository.transitionState({
          ref: input.ref,
          expectedStateSeq: input.expectedStateSeq,
          to: "active",
          current: currentBefore,
        }),
      ),
      { expect: token },
    ).pipe(
      Effect.catchTag("ProjectSkillMutationFenceStaleExpect", () =>
        Effect.fail(new ProjectSkillStoreRejectedError({ reason: "state-changed" })),
      ),
    );
    return yield* mapTransitionOutcome(transition);
  });

  const retire = Effect.fn("ProjectSkillService.retire")(function* (
    input: RetireProjectSkillInput,
  ) {
    const lifecycleBefore = yield* guarded(repository.readLifecycle({ ref: input.ref }));
    if (Option.isNone(lifecycleBefore)) {
      return yield* new ProjectSkillStoreNotFoundError({});
    }
    if (lifecycleBefore.value.stateSeq !== input.expectedStateSeq) {
      return yield* new ProjectSkillStoreRejectedError({ reason: "state-changed" });
    }
    const transition = yield* guarded(
      mutateProject(
        input.ref.projectId,
        repository.transitionState({
          ref: input.ref,
          expectedStateSeq: input.expectedStateSeq,
          to: "retired",
        }),
      ),
    );
    return yield* mapTransitionOutcome(transition);
  });

  return {
    deriveDraft,
    createCandidate,
    revise,
    listSkills,
    get,
    recordJudgment,
    withdrawJudgment,
    deleteSkill,
    activate,
    retire,
  };
});

export const layer = Layer.effect(ProjectSkillService, make);
