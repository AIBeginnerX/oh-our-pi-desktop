import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROJECT_MEMORY_MAX_LIMIT,
  type ProjectMemory,
  type ProjectMemoryAcknowledgeThreadInput,
  type ProjectMemoryAcknowledgeThreadResult,
  type ProjectMemoryCreateInput,
  ProjectMemoryConflictError,
  type ProjectMemoryDeleteInput,
  type ProjectMemoryGetInput,
  type ProjectMemoryGetResult,
  ProjectMemoryId,
  type ProjectMemoryListInput,
  type ProjectMemoryListResult,
  ProjectMemoryNotFoundError,
  type ProjectId,
  ProjectMemoryRejectedError,
  type ProjectMemorySearchInput,
  type ProjectMemorySearchResult,
  ProjectMemoryStoreError,
  type ProjectMemorySummary,
  type ProjectMemoryThreadChange,
  type ProjectMemoryThreadState,
  type ProjectMemoryThreadStateInput,
  type ProjectMemoryUpdateInput,
  type ProjectMemoryWriteResult,
} from "@t3tools/contracts";

import { ProjectMemoryRepository } from "../persistence/ProjectMemories.ts";
import { ProjectMemorySendLedger } from "../persistence/ProjectMemorySendLedger.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { makeSearchPlan, planHasTerms } from "./memorySearch.ts";
import { looksLikeSensitiveText } from "./sensitiveText.ts";

/**
 * Project memory management service (T5a). It owns validation policy:
 * same-project scope, verified `message` provenance, the best-effort
 * sensitive-text rejection, and optimistic `expectedVersion` writes.
 * Liveness and provenance are enforced atomically inside the repository's
 * write statements — a preflight check could interleave a tombstone between
 * the read and the write. Errors are always the fixed-message contract
 * errors — rejected titles/bodies and rejected secrets never appear on them.
 *
 * Text is stored NFC-normalized: display is unchanged, and FTS/LIKE searches
 * match regardless of the paste-time normalization form. The estimate and the
 * sensitive scan run on the normalized text that will actually be stored.
 *
 * Expiry is *not* a read filter: expired memories stay listable and
 * deletable so users can manage them; `validUntil` is enforced when content
 * would be consumed (the sending tranche), not here.
 */
export class ProjectMemoryService extends Context.Service<
  ProjectMemoryService,
  {
    readonly list: (
      input: ProjectMemoryListInput,
    ) => Effect.Effect<ProjectMemoryListResult, ProjectMemoryStoreError>;
    readonly search: (
      input: ProjectMemorySearchInput,
    ) => Effect.Effect<ProjectMemorySearchResult, ProjectMemoryStoreError>;
    readonly get: (
      input: ProjectMemoryGetInput,
    ) => Effect.Effect<
      ProjectMemoryGetResult,
      ProjectMemoryNotFoundError | ProjectMemoryStoreError
    >;
    readonly create: (
      input: ProjectMemoryCreateInput,
    ) => Effect.Effect<
      ProjectMemoryWriteResult,
      ProjectMemoryRejectedError | ProjectMemoryStoreError
    >;
    readonly update: (
      input: ProjectMemoryUpdateInput,
    ) => Effect.Effect<
      ProjectMemoryWriteResult,
      | ProjectMemoryNotFoundError
      | ProjectMemoryConflictError
      | ProjectMemoryRejectedError
      | ProjectMemoryStoreError
    >;
    readonly delete: (
      input: ProjectMemoryDeleteInput,
    ) => Effect.Effect<
      void,
      ProjectMemoryNotFoundError | ProjectMemoryConflictError | ProjectMemoryStoreError
    >;
    readonly threadState: (
      input: ProjectMemoryThreadStateInput,
    ) => Effect.Effect<
      ProjectMemoryThreadState,
      ProjectMemoryRejectedError | ProjectMemoryStoreError
    >;
    readonly acknowledgeThread: (
      input: ProjectMemoryAcknowledgeThreadInput,
    ) => Effect.Effect<
      ProjectMemoryAcknowledgeThreadResult,
      ProjectMemoryRejectedError | ProjectMemoryStoreError
    >;
  }
>()("t3/memory/ProjectMemoryService") {}

const toSummary = (record: ProjectMemory): ProjectMemorySummary => ({
  memoryId: record.memoryId,
  projectId: record.projectId,
  kind: record.kind,
  title: record.title,
  version: record.version,
  origin: record.origin,
  validUntil: record.validUntil,
  estimatedTokens: record.estimatedTokens,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/** Heuristic only: ~4 characters per token. Deliberately not calibrated for
    non-Latin scripts — it exists for budget displays, not tokenizers. */
const estimateTokens = (title: string, body: string) =>
  Math.max(1, Math.ceil((title.length + body.length) / 4));

const normalizeInstant = (value: string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

const PROJECT_MEMORY_THREAD_CHANGES_DEFAULT = 20;

// Schema.Defect recursively serializes causes, which can contain memory text.
// Public storage failures therefore carry only the fixed message.
const toStoreError = (): ProjectMemoryStoreError =>
  new ProjectMemoryStoreError({ message: "Project memory operation failed." });

const passThroughOrStore =
  <E>(isContractError: (cause: unknown) => cause is E) =>
  (cause: unknown): E | ProjectMemoryStoreError =>
    isContractError(cause) ? cause : toStoreError();

const isRejectedOrStore = (
  cause: unknown,
): cause is ProjectMemoryRejectedError | ProjectMemoryStoreError =>
  cause instanceof ProjectMemoryRejectedError || cause instanceof ProjectMemoryStoreError;

const isReadOrStore = (
  cause: unknown,
): cause is ProjectMemoryNotFoundError | ProjectMemoryStoreError =>
  cause instanceof ProjectMemoryNotFoundError || cause instanceof ProjectMemoryStoreError;

const isWriteError = (
  cause: unknown,
): cause is
  | ProjectMemoryNotFoundError
  | ProjectMemoryConflictError
  | ProjectMemoryRejectedError
  | ProjectMemoryStoreError =>
  cause instanceof ProjectMemoryNotFoundError ||
  cause instanceof ProjectMemoryConflictError ||
  cause instanceof ProjectMemoryRejectedError ||
  cause instanceof ProjectMemoryStoreError;

const isDeleteError = (
  cause: unknown,
): cause is ProjectMemoryNotFoundError | ProjectMemoryConflictError | ProjectMemoryStoreError =>
  cause instanceof ProjectMemoryNotFoundError ||
  cause instanceof ProjectMemoryConflictError ||
  cause instanceof ProjectMemoryStoreError;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const repository = yield* ProjectMemoryRepository;
  const ledger = yield* ProjectMemorySendLedger;
  const threadRepository = yield* ProjectionThreadRepository;
  const projectRepository = yield* ProjectionProjectRepository;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const browse = (projectId: ProjectId, limit: number) =>
    repository.listForProject({ projectId, limit }).pipe(
      Effect.map((page) => ({
        items: page.items.map(toSummary),
        truncated: page.truncated,
      })),
    );

  const list: ProjectMemoryService["Service"]["list"] = (input) =>
    browse(input.projectId, input.limit ?? PROJECT_MEMORY_MAX_LIMIT).pipe(
      Effect.mapError(toStoreError),
    );

  const search: ProjectMemoryService["Service"]["search"] = (input) => {
    const limit = input.limit ?? PROJECT_MEMORY_MAX_LIMIT;
    const plan = makeSearchPlan((input.query ?? "").normalize("NFC"));
    return (
      planHasTerms(plan)
        ? repository.search({ projectId: input.projectId, ...plan, limit }).pipe(
            Effect.map((page) => ({
              items: page.items.map(toSummary),
              truncated: page.truncated,
            })),
          )
        : browse(input.projectId, limit)
    ).pipe(Effect.mapError(toStoreError));
  };

  const get: ProjectMemoryService["Service"]["get"] = (input) =>
    repository.getById(input).pipe(
      Effect.mapError(passThroughOrStore(isReadOrStore)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ProjectMemoryNotFoundError({
                projectId: input.projectId,
                memoryId: input.memoryId,
              }),
            ),
          onSome: (memory) => Effect.succeed({ memory } satisfies ProjectMemoryGetResult),
        }),
      ),
    );

  const create: ProjectMemoryService["Service"]["create"] = (input) =>
    Effect.gen(function* () {
      const origin = input.origin ?? { type: "manual" as const };
      const title = input.title.normalize("NFC");
      const body = input.body.normalize("NFC");
      if (looksLikeSensitiveText(title) || looksLikeSensitiveText(body)) {
        return yield* new ProjectMemoryRejectedError({ reason: "sensitive" });
      }
      const memoryId = ProjectMemoryId.make(yield* crypto.randomUUIDv4);
      const now = DateTime.formatIso(yield* DateTime.now);
      const outcome = yield* repository.insert({
        memoryId,
        projectId: input.projectId,
        kind: input.kind,
        title,
        body,
        origin,
        validUntil: input.validUntil === undefined ? null : normalizeInstant(input.validUntil),
        estimatedTokens: estimateTokens(title, body),
        now,
      });
      switch (outcome.status) {
        case "applied":
          return { memory: outcome.record } satisfies ProjectMemoryWriteResult;
        case "project-missing":
          return yield* new ProjectMemoryRejectedError({ reason: "project-missing" });
        case "origin-invalid":
          return yield* new ProjectMemoryRejectedError({ reason: "origin-invalid" });
      }
    }).pipe(Effect.mapError(passThroughOrStore(isRejectedOrStore)));

  const update: ProjectMemoryService["Service"]["update"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository.getById(input).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ProjectMemoryNotFoundError({
                  projectId: input.projectId,
                  memoryId: input.memoryId,
                }),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
      if (existing.version !== input.expectedVersion) {
        return yield* new ProjectMemoryConflictError({
          projectId: input.projectId,
          memoryId: input.memoryId,
          currentVersion: existing.version,
        });
      }
      const title = (input.title ?? existing.title).normalize("NFC");
      const body = (input.body ?? existing.body).normalize("NFC");
      if (looksLikeSensitiveText(title) || looksLikeSensitiveText(body)) {
        return yield* new ProjectMemoryRejectedError({ reason: "sensitive" });
      }
      // Fenced: the epoch/inflight pair stays held until the repository's
      // outer transaction actually commits or rolls back.
      const outcome = yield* ledger.withMemoryMutation(
        repository.update({
          projectId: input.projectId,
          memoryId: input.memoryId,
          expectedVersion: input.expectedVersion,
          title,
          body,
          kind: input.kind ?? existing.kind,
          validUntil:
            input.validUntil === undefined
              ? existing.validUntil
              : normalizeInstant(input.validUntil),
          estimatedTokens: estimateTokens(title, body),
          now: DateTime.formatIso(yield* DateTime.now),
        }),
      );
      switch (outcome.status) {
        case "applied":
          return { memory: outcome.record } satisfies ProjectMemoryWriteResult;
        case "not-found":
          return yield* new ProjectMemoryNotFoundError({
            projectId: input.projectId,
            memoryId: input.memoryId,
          });
        case "conflict":
          return yield* new ProjectMemoryConflictError({
            projectId: input.projectId,
            memoryId: input.memoryId,
            currentVersion: outcome.currentVersion,
          });
      }
    }).pipe(Effect.mapError(passThroughOrStore(isWriteError)));

  const deleteMemory: ProjectMemoryService["Service"]["delete"] = (input) =>
    Effect.gen(function* () {
      const outcome = yield* ledger.withMemoryMutation(repository.delete(input));
      switch (outcome.status) {
        case "applied":
          return;
        case "not-found":
          return yield* new ProjectMemoryNotFoundError({
            projectId: input.projectId,
            memoryId: input.memoryId,
          });
        case "conflict":
          return yield* new ProjectMemoryConflictError({
            projectId: input.projectId,
            memoryId: input.memoryId,
            currentVersion: outcome.currentVersion,
          });
      }
    }).pipe(Effect.mapError(passThroughOrStore(isDeleteError)));

  const threadState: ProjectMemoryService["Service"]["threadState"] = (input) =>
    // One transaction on the shared client: the live-scope read, the ledger
    // snapshot, and the memory-id masking all see the same read snapshot.
    sql
      .withTransaction(
        Effect.gen(function* () {
          const thread = yield* threadRepository.getById({ threadId: input.threadId });
          const project = yield* projectRepository.getById({ projectId: input.projectId });
          const live =
            Option.isSome(thread) &&
            thread.value.deletedAt === null &&
            thread.value.projectId === input.projectId &&
            Option.isSome(project) &&
            project.value.deletedAt === null;
          if (!live) {
            return { status: "thread-missing" } as const;
          }
          const limit = input.limit ?? PROJECT_MEMORY_THREAD_CHANGES_DEFAULT;
          const affected = yield* ledger.affectedState({ threadId: input.threadId, limit });
          // Ids whose memory is absent from this project's live snapshot
          // (another project's id, or a deleted memory) are masked; the row,
          // seq, reason, and hold verdict are not.
          const liveById = new Map<ProjectMemoryId, boolean>();
          for (const change of affected.changes) {
            if (liveById.has(change.memoryId)) continue;
            const memory = yield* repository.getById({
              projectId: input.projectId,
              memoryId: change.memoryId,
            });
            liveById.set(change.memoryId, Option.isSome(memory));
          }
          const changes = affected.changes.map((change): ProjectMemoryThreadChange =>
            liveById.get(change.memoryId) === true
              ? {
                  changeSeq: change.changeSeq,
                  reason: change.reason,
                  memoryId: change.memoryId,
                }
              : { changeSeq: change.changeSeq, reason: change.reason },
          );
          return {
            status: "ok" as const,
            state: {
              held: affected.held,
              latestChangeSeq: affected.latestChangeSeq,
              acknowledgedThrough: affected.ackedThrough,
              changes,
              mayHaveMore: changes.length === limit,
            } satisfies ProjectMemoryThreadState,
          };
        }),
      )
      .pipe(
        // Local rejections stay values until this point, so every cause seen
        // here is foreign: typed errors, defects, and foreign StoreError /
        // RejectedError objects all collapse to a fresh fixed StoreError. A
        // cause carrying an interrupt becomes a fresh pure interrupt — the
        // original cause is never rethrown because it may retain secrets.
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(toStoreError()),
        ),
        Effect.flatMap((outcome) =>
          outcome.status === "ok"
            ? Effect.succeed(outcome.state)
            : Effect.fail(new ProjectMemoryRejectedError({ reason: "thread-missing" })),
        ),
      );

  const acknowledgeThread: ProjectMemoryService["Service"]["acknowledgeThread"] = (input) =>
    // No preflight and no post-commit reread: the ledger's in-transaction
    // scope guard is the liveness proof, so the result cannot report a state
    // that the commit did not decide.
    ledger
      .acknowledge({
        threadId: input.threadId,
        throughChangeSeq: input.throughChangeSeq,
        expectedProjectId: input.projectId,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.interrupt : Effect.fail(toStoreError()),
        ),
        Effect.flatMap((outcome) => {
          switch (outcome.status) {
            case "applied":
            case "unchanged":
              return Effect.succeed({
                status: outcome.status,
                acknowledgedThrough: outcome.ackedThrough,
              } satisfies ProjectMemoryAcknowledgeThreadResult);
            case "scope-mismatch":
              return Effect.fail(new ProjectMemoryRejectedError({ reason: "thread-missing" }));
            case "invalid":
              return Effect.fail(
                new ProjectMemoryRejectedError({ reason: "acknowledgement-invalid" }),
              );
          }
        }),
      );

  return {
    list,
    search,
    get,
    create,
    update,
    delete: deleteMemory,
    threadState,
    acknowledgeThread,
  } satisfies ProjectMemoryService["Service"];
});

export const layer = Layer.effect(ProjectMemoryService, make);
