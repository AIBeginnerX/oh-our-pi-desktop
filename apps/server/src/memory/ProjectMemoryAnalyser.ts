import * as Crypto from "effect/Crypto";
import { PROJECT_MEMORY_TIDY_PENDING_MAX, ProjectMemoryTidyId } from "@t3tools/contracts";
import { tidyStore } from "./tidyStore.ts";
import { buildMemoryTidyInput, selectTidyMemories, selectMemoryTidies } from "./memoryTidy.ts";
import { PROJECT_MEMORY_SEND_DRIVER_KINDS } from "./ProjectMemorySendProviders.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  PROJECT_MEMORY_ANALYSER_PENDING_MAX,
  type ProjectId,
  type ProjectMemoryAnalyseInput,
  type ProjectMemoryAnalyseResult,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { lookupMemoryEchoThreadState } from "../orchestration/memoryEcho.ts";
import { ProjectMemoryRepository } from "../persistence/ProjectMemories.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { buildDigestPromptInput, selectDigestInputs, selectLessons } from "./derivedLessons.ts";
import { ProjectMemoryService } from "./ProjectMemoryService.ts";
import { recordMemoryOutcomes } from "./memoryOutcomeStore.ts";
import { readThreadWorkDigest } from "./workDigestReader.ts";
import {
  type ThreadWorkDigest,
  withoutProviderText,
  withoutUnverifiedAuditText,
} from "./workDigest.ts";

/** Most recently active threads one run looks at. */
export const ANALYSER_THREAD_WINDOW = 20;

/** Summary of one dreaming pass over the server's live projects. */
export interface ProjectMemoryDreamResult {
  readonly projects: number;
  /** Projects skipped after an error; the rest still ran. */
  readonly failed: number;
}

/**
 * The work analyser: reads structured digests of a project's recent threads,
 * asks the one-shot text-generation service for reusable lessons, and files
 * the ones the digests back as pending suggestions. It only runs when the
 * user asks, only while the `projectMemoryAnalyser` setting is on, and never
 * applies anything: every suggestion waits in the approval list.
 */
export class ProjectMemoryAnalyser extends Context.Service<
  ProjectMemoryAnalyser,
  {
    readonly analyse: (
      input: ProjectMemoryAnalyseInput,
    ) => Effect.Effect<
      ProjectMemoryAnalyseResult,
      ProjectMemoryRejectedError | ProjectMemoryStoreError
    >;
    /**
     * One dreaming pass over every live project, under the same one-run gate
     * as `analyse`, with suggestions filed as dreamed. Never fails: a project
     * that errors is logged and skipped.
     */
    readonly dream: Effect.Effect<ProjectMemoryDreamResult, never>;
  }
>()("t3/memory/ProjectMemoryAnalyser") {}

const isRejected = Schema.is(ProjectMemoryRejectedError);
const isStoreError = Schema.is(ProjectMemoryStoreError);

const toStoreError = () =>
  new ProjectMemoryStoreError({ message: "Project memory operation failed." });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const repository = yield* ProjectMemoryRepository;
  const memories = yield* ProjectMemoryService;
  const projects = yield* ProjectionProjectRepository;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  // One run per server at a time: two overlapping runs would read the same cursor.
  const gate = yield* Semaphore.make(1);

  const recentThreads = (projectId: ProjectId, cursor: number) =>
    sql<{
      readonly threadId: ThreadId;
      readonly parentThreadId: ThreadId | null;
      readonly lastSequence: number;
    }>`
      SELECT t.thread_id AS "threadId", t.parent_thread_id AS "parentThreadId",
        MAX(e.sequence) AS "lastSequence"
      FROM projection_threads t
      JOIN orchestration_events e
        ON e.aggregate_kind = 'thread' AND e.stream_id = t.thread_id
      WHERE t.project_id = ${projectId} AND t.deleted_at IS NULL
      GROUP BY t.thread_id
      ORDER BY MAX(e.sequence) DESC
      LIMIT ${ANALYSER_THREAD_WINDOW}
    `.pipe(
      Effect.map((rows) => ({
        threads: rows.map((row) => row.threadId),
        leadOf: new Map(
          rows.flatMap((row) =>
            row.parentThreadId === null ? [] : ([[row.threadId, row.parentThreadId]] as const),
          ),
        ),
        hasNew: rows.some((row) => row.lastSequence > cursor),
        head: rows.reduce((max, row) => Math.max(max, row.lastSequence), cursor),
      })),
    );

  const digestOf = (projectId: ProjectId, threadId: ThreadId, leadId: ThreadId | null) =>
    Effect.gen(function* () {
      const work = yield* readThreadWorkDigest(sql, threadId, leadId);
      if (work === null) return null;
      yield* recordMemoryOutcomes(sql, projectId, work);
      const { digest } = work;
      // A thread that received memory text may echo it back: keep its provider text out.
      const echo = yield* lookupMemoryEchoThreadState(sql, threadId);
      if (echo !== "clean") return withoutProviderText(digest);
      // An auditor's excerpt was written in its own child thread, whose echo
      // state is separate from the lead's.
      const clean = new Set<ThreadId>();
      for (const source of new Set(digest.audits.map((audit) => audit.sourceThreadId))) {
        if (source !== null && (yield* lookupMemoryEchoThreadState(sql, source)) === "clean") {
          clean.add(source);
        }
      }
      return withoutUnverifiedAuditText(digest, clean);
    });

  const runProject = (
    projectId: ProjectId,
    dreamed: boolean,
    settings: ServerSettingsValue,
    counts: {
      threadsRead: number;
      threadsWithSignals: number;
      candidatesReturned: number;
      suggestionsFiled: number;
      queueFull: boolean;
    },
  ) =>
    Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
        settings,
        projectId,
      ).settings;
      const tidiesSuggested = yield* Effect.gen(function* () {
        if (!settings.projectMemoryTidy) return 0;
        const instance = settings.providerInstances[modelSelection.instanceId];
        if (
          !instance ||
          !instance.enabled ||
          !PROJECT_MEMORY_SEND_DRIVER_KINDS.has(instance.driver)
        )
          return 0;
        const fingerprintRows = yield* sql<{ fingerprint: string }>`SELECT
          CAST(COUNT(*) AS TEXT) || ':' || COALESCE(MAX(updated_at), '') || ':' || COALESCE(SUM(version), 0) AS fingerprint
          FROM project_memories WHERE project_id = ${projectId}`;
        const fingerprint = fingerprintRows[0]!.fingerprint;
        const cursors = yield* sql<{
          fingerprint: string | null;
        }>`SELECT tidy_fingerprint AS fingerprint FROM project_memory_analysis_cursors WHERE project_id = ${projectId}`;
        if (cursors[0]?.fingerprint === fingerprint) return 0;
        const pending = yield* tidyStore(sql).list(projectId);
        if (pending.length >= PROJECT_MEMORY_TIDY_PENDING_MAX) return 0;
        const records = yield* repository.listForProject({ projectId, limit: 10000 });
        const eligible = selectTidyMemories(
          records.items,
          new Set(pending.flatMap((p) => p.memories.map((m) => m.memoryId))),
        );
        if (eligible.length < 2) return 0;
        const generated = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3code-tidy-" })
          .pipe(
            Effect.flatMap((cwd) =>
              textGeneration.generateMemoryTidy({
                cwd,
                digest: buildMemoryTidyInput(eligible),
                modelSelection,
              }),
            ),
            Effect.scoped,
          );
        const accepted = selectMemoryTidies(generated, eligible, pending.length);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const suggestion of accepted) {
              yield* tidyStore(sql).insert({
                tidyId: ProjectMemoryTidyId.make(yield* crypto.randomUUIDv4),
                projectId,
                action: suggestion.action,
                title: suggestion.title ?? null,
                body: suggestion.body ?? null,
                reason: suggestion.reason,
                memories: suggestion.memories.map(({ memoryId, version }) => ({
                  memoryId,
                  version,
                })),
                dreamed,
                createdAt: now,
              });
            }
            yield* sql`INSERT INTO project_memory_analysis_cursors (project_id, last_event_sequence, updated_at, tidy_fingerprint)
            SELECT ${projectId}, 0, ${now}, ${fingerprint} WHERE EXISTS (SELECT 1 FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL) ON CONFLICT(project_id) DO UPDATE SET tidy_fingerprint = excluded.tidy_fingerprint`;
          }),
        );
        return accepted.length;
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.failCause(cause) : Effect.succeed(0),
        ),
      );
      const none = {
        threadsAnalysed: 0,
        memoriesProposed: 0,
        skillsSuggested: 0,
        ...(tidiesSuggested > 0 ? { tidiesSuggested } : {}),
      } as const;
      // A full review queue pauses the work analysis: no model call, and the cursor stays so the
      // same work is read once review frees a slot. Tidy suggestions have their own queue.
      const [queue] = yield* sql<{ readonly pending: number }>`
        SELECT COUNT(*) AS pending
        FROM project_memory_proposals
        WHERE project_id = ${projectId} AND source = 'analyser'
      `;
      if (queue!.pending >= PROJECT_MEMORY_ANALYSER_PENDING_MAX) {
        counts.queueFull = true;
        return none;
      }
      const cursor = yield* repository.getAnalysisCursor({ projectId });
      const recent = yield* recentThreads(projectId, cursor);
      const advance = repository.advanceAnalysisCursor({
        projectId,
        sequence: recent.head,
        now: DateTime.formatIso(yield* DateTime.now),
      });
      const digests: Array<ThreadWorkDigest> = [];
      if (recent.hasNew) {
        for (const threadId of recent.threads) {
          counts.threadsRead += 1;
          const digest = yield* digestOf(projectId, threadId, recent.leadOf.get(threadId) ?? null);
          if (digest !== null) {
            digests.push(digest);
            if (digest.signals.length > 0) counts.threadsWithSignals += 1;
          }
        }
      }
      const { promptDigests, ...stages } = selectDigestInputs(digests);
      let lessonsSupported = 0;
      return yield* Effect.gen(function* () {
        if (!recent.hasNew) return none;
        if (promptDigests.length === 0) {
          yield* advance;
          return none;
        }

        // The model reads only the digest, so it runs in an empty directory rather than
        // the workspace, where it could pick up the project's files and instructions.
        const generated = yield* fileSystem
          .makeTempDirectoryScoped({ prefix: "t3code-analyser-" })
          .pipe(
            Effect.flatMap((cwd) =>
              textGeneration.generateWorkLessons({
                cwd,
                digest: buildDigestPromptInput(promptDigests),
                modelSelection,
              }),
            ),
            Effect.scoped,
            Effect.mapError(() => new ProjectMemoryRejectedError({ reason: "analyser-failed" })),
          );

        let memoriesProposed = 0;
        let skillsSuggested = 0;
        counts.candidatesReturned = generated.lessons.length;
        const candidates = selectLessons(generated, promptDigests);
        lessonsSupported = candidates.length;
        for (const candidate of candidates) {
          const outcome = yield* memories.proposeDerived({
            projectId,
            target: candidate.target,
            text: candidate.text,
            evidence: candidate.evidence,
            evidenceNamed: candidate.evidenceNamed,
            ...(dreamed ? { dreamed: true } : {}),
          });
          if (outcome.status === "limit-reached") {
            counts.queueFull = true;
            break;
          }
          if (outcome.status !== "proposed") continue;
          counts.suggestionsFiled += 1;
          if (candidate.target === "skill") skillsSuggested += 1;
          else memoriesProposed += 1;
        }
        if (!counts.queueFull) yield* advance;
        return {
          ...none,
          threadsAnalysed: promptDigests.length,
          memoriesProposed,
          skillsSuggested,
        };
      }).pipe(
        Effect.onExit((exit) =>
          Effect.logInfo("project memory analyser stages", {
            projectId,
            dreamed,
            hasNew: recent.hasNew,
            threadsInWindow: recent.threads.length,
            threadsRead: recent.hasNew ? recent.threads.length : 0,
            digestsBuilt: digests.length,
            ...stages,
            promptDigests: promptDigests.length,
            lessonsGenerated: counts.candidatesReturned,
            lessonsSupported,
            memoriesProposed: Exit.isSuccess(exit) ? exit.value.memoriesProposed : null,
            skillsSuggested: Exit.isSuccess(exit) ? exit.value.skillsSuggested : null,
            failed: Exit.isFailure(exit),
          }),
        ),
      );
    });

  const run = (
    projectId: ProjectId,
    dreamed: boolean,
  ): Effect.Effect<
    ProjectMemoryAnalyseResult,
    ProjectMemoryRejectedError | ProjectMemoryStoreError
  > =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      if (!settings.projectMemoryAnalyser) {
        return yield* new ProjectMemoryRejectedError({ reason: "analyser-disabled" });
      }
      const project = yield* projects.getById({ projectId });
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* new ProjectMemoryRejectedError({ reason: "project-missing" });
      }
      const lastAttemptAt = DateTime.formatIso(yield* DateTime.now);
      // Filled in as the run goes, so a run that fails part-way still records what it saw. The
      // record holds counts and an outcome only, never text from the work.
      const counts = {
        threadsRead: 0,
        threadsWithSignals: 0,
        candidatesReturned: 0,
        suggestionsFiled: 0,
        queueFull: false,
      };
      return yield* runProject(projectId, dreamed, settings, counts).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const failed = Exit.isFailure(exit);
            const lastSuccessAt = failed ? null : DateTime.formatIso(yield* DateTime.now);
            const outcome = failed
              ? "failed"
              : counts.queueFull
                ? "queue-full"
                : counts.suggestionsFiled > 0
                  ? "proposed"
                  : counts.threadsWithSignals === 0
                    ? "no-signals"
                    : "no-candidates";

            yield* sql`
              INSERT INTO project_memory_analysis_health (
                project_id, last_attempt_at, last_success_at, threads_read,
                threads_with_signals, candidates_returned, suggestions_filed, outcome
              )
              SELECT ${projectId}, ${lastAttemptAt}, ${lastSuccessAt}, ${counts.threadsRead},
                ${counts.threadsWithSignals}, ${counts.candidatesReturned}, ${counts.suggestionsFiled}, ${outcome}
              WHERE EXISTS (
                SELECT 1 FROM projection_projects WHERE project_id = ${projectId} AND deleted_at IS NULL
              )
              ON CONFLICT(project_id) DO UPDATE SET
                last_attempt_at = excluded.last_attempt_at,
                last_success_at = COALESCE(excluded.last_success_at, last_success_at),
                threads_read = excluded.threads_read,
                threads_with_signals = excluded.threads_with_signals,
                candidates_returned = excluded.candidates_returned,
                suggestions_filed = excluded.suggestions_filed,
                outcome = excluded.outcome
            `.pipe(
              Effect.catch(() =>
                Effect.logWarning("project memory analysis health could not be saved", {
                  projectId,
                }),
              ),
            );
          }),
        ),
        Effect.map((result) =>
          counts.queueFull ? { ...result, queueFull: true as const } : result,
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isRejected(cause) || isStoreError(cause) ? cause : toStoreError(),
      ),
    );

  // One pass over every live project, in a stable order so logs read the same
  // way across runs. A project that errors is logged and skipped: one bad
  // project must not starve the rest of the server of its pass.
  const dream: Effect.Effect<ProjectMemoryDreamResult, never> = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    if (!settings.projectMemoryAnalyser) return { projects: 0, failed: 0 };
    const rows = yield* sql<{ readonly projectId: ProjectId }>`
      SELECT project_id AS "projectId"
      FROM projection_projects
      WHERE deleted_at IS NULL
      ORDER BY project_id ASC
    `;
    let failed = 0;
    for (const row of rows) {
      // Both contract errors carry `_tag`; the result shape does not.
      const outcome = yield* run(row.projectId, true).pipe(
        Effect.catch((error) => Effect.succeed(error)),
      );
      if ("_tag" in outcome) {
        failed += 1;
        yield* Effect.logWarning("dreaming skipped a project", {
          projectId: row.projectId,
          reason: isRejected(outcome) ? outcome.reason : "store-failed",
        });
      }
    }
    return { projects: rows.length, failed };
  }).pipe(
    // A settings or store failure before any project ran ends the pass; the
    // next wake re-plans. Nothing sensitive is on these errors.
    Effect.catch(() =>
      Effect.logWarning("project memory dreaming pass could not enumerate projects").pipe(
        Effect.as({ projects: 0, failed: 0 }),
      ),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("project memory dreaming pass failed", { cause }).pipe(
            Effect.as({ projects: 0, failed: 0 }),
          ),
    ),
  );

  return {
    analyse: (input) => gate.withPermits(1)(run(input.projectId, false)),
    dream: gate.withPermits(1)(dream),
  } satisfies ProjectMemoryAnalyser["Service"];
});

export const layer = Layer.effect(ProjectMemoryAnalyser, make);
