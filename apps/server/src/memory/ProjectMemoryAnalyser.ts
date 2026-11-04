import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type ProjectId,
  type ProjectMemoryAnalyseInput,
  type ProjectMemoryAnalyseResult,
  ProjectMemoryRejectedError,
  ProjectMemoryStoreError,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";

import { lookupMemoryEchoThreadState } from "../orchestration/memoryEcho.ts";
import { ProjectMemoryRepository } from "../persistence/ProjectMemories.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { OrchestrationEventStore } from "../persistence/Services/OrchestrationEventStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { buildDigestPromptInput, isAnalysable, selectLessons } from "./derivedLessons.ts";
import { ProjectMemoryService } from "./ProjectMemoryService.ts";
import { readThreadWorkDigest } from "./workDigestReader.ts";
import {
  type ThreadWorkDigest,
  withoutProviderText,
  withoutUnverifiedAuditText,
} from "./workDigest.ts";

/** Most recently active threads one run looks at. */
export const ANALYSER_THREAD_WINDOW = 20;

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
  }
>()("t3/memory/ProjectMemoryAnalyser") {}

const isRejected = Schema.is(ProjectMemoryRejectedError);
const isStoreError = Schema.is(ProjectMemoryStoreError);

const toStoreError = () =>
  new ProjectMemoryStoreError({ message: "Project memory operation failed." });

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* OrchestrationEventStore;
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

  const digestOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const digest = yield* readThreadWorkDigest(sql, store, threadId);
      if (digest === null) return null;
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

  const run = (
    input: ProjectMemoryAnalyseInput,
  ): Effect.Effect<
    ProjectMemoryAnalyseResult,
    ProjectMemoryRejectedError | ProjectMemoryStoreError
  > =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      if (!settings.projectMemoryAnalyser) {
        return yield* new ProjectMemoryRejectedError({ reason: "analyser-disabled" });
      }
      const project = yield* projects.getById({ projectId: input.projectId });
      if (Option.isNone(project) || project.value.deletedAt !== null) {
        return yield* new ProjectMemoryRejectedError({ reason: "project-missing" });
      }
      const none = { threadsAnalysed: 0, memoriesProposed: 0, skillsSuggested: 0 } as const;
      const cursor = yield* repository.getAnalysisCursor({ projectId: input.projectId });
      const recent = yield* recentThreads(input.projectId, cursor);
      const advance = repository.advanceAnalysisCursor({
        projectId: input.projectId,
        sequence: recent.head,
        now: DateTime.formatIso(yield* DateTime.now),
      });
      if (!recent.hasNew) return none;

      const digests: Array<ThreadWorkDigest> = [];
      for (const threadId of recent.threads) {
        const digest = yield* digestOf(threadId);
        if (digest !== null && isAnalysable(digest)) digests.push(digest);
      }
      if (digests.length === 0) {
        yield* advance;
        return none;
      }

      const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
        settings,
        input.projectId,
      ).settings;
      // The model reads only the digest, so it runs in an empty directory rather than
      // the workspace, where it could pick up the project's files and instructions.
      const generated = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3code-analyser-" })
        .pipe(
          Effect.flatMap((cwd) =>
            textGeneration.generateWorkLessons({
              cwd,
              digest: buildDigestPromptInput(digests),
              modelSelection,
            }),
          ),
          Effect.scoped,
          Effect.mapError(() => new ProjectMemoryRejectedError({ reason: "analyser-failed" })),
        );

      let memoriesProposed = 0;
      let skillsSuggested = 0;
      for (const candidate of selectLessons(generated, digests, recent.leadOf)) {
        const outcome = yield* memories.proposeDerived({
          projectId: input.projectId,
          target: candidate.target,
          text: candidate.text,
          evidence: candidate.evidence,
          evidenceNamed: candidate.evidenceNamed,
        });
        if (outcome.status !== "proposed") continue;
        if (candidate.target === "skill") skillsSuggested += 1;
        else memoriesProposed += 1;
      }
      yield* advance;
      return { threadsAnalysed: digests.length, memoriesProposed, skillsSuggested };
    }).pipe(
      Effect.mapError((cause) =>
        isRejected(cause) || isStoreError(cause) ? cause : toStoreError(),
      ),
    );

  return {
    analyse: (input) => gate.withPermits(1)(run(input)),
  } satisfies ProjectMemoryAnalyser["Service"];
});

export const layer = Layer.effect(ProjectMemoryAnalyser, make);
