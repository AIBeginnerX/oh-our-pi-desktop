import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  type ProjectMemory,
  ProjectMemoryId,
  ProjectMemoryKind,
  ProjectMemoryOrigin,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  type PersistenceErrorCorrelation,
  type ProjectMemoryRepositoryError,
  isPersistenceError,
  PersistenceDecodeError,
  PersistenceSqlError,
} from "./Errors.ts";

export const InsertProjectMemoryInput = Schema.Struct({
  memoryId: ProjectMemoryId,
  projectId: ProjectId,
  kind: ProjectMemoryKind,
  title: Schema.String,
  body: Schema.String,
  origin: ProjectMemoryOrigin,
  validUntil: Schema.NullOr(Schema.String),
  estimatedTokens: NonNegativeInt,
  now: Schema.String,
});
export type InsertProjectMemoryInput = typeof InsertProjectMemoryInput.Type;

export const GetProjectMemoryInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: ProjectMemoryId,
});
export type GetProjectMemoryInput = typeof GetProjectMemoryInput.Type;

export const ListProjectMemoriesInput = Schema.Struct({
  projectId: ProjectId,
  limit: PositiveInt,
});
export type ListProjectMemoriesInput = typeof ListProjectMemoriesInput.Type;

export const SearchProjectMemoriesInput = Schema.Struct({
  projectId: ProjectId,
  /** Combined FTS5 phrase query for positive 3+ codepoint terms, or null. */
  ftsMatch: Schema.NullOr(Schema.String),
  /** Escaped `%…%` patterns (ESCAPE '!') for positive 1–2 codepoint terms. */
  likePatterns: Schema.Array(Schema.String),
  limit: PositiveInt,
});
export type SearchProjectMemoriesInput = typeof SearchProjectMemoriesInput.Type;

export const UpdateProjectMemoryInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: ProjectMemoryId,
  expectedVersion: PositiveInt,
  title: Schema.String,
  body: Schema.String,
  kind: ProjectMemoryKind,
  validUntil: Schema.NullOr(Schema.String),
  estimatedTokens: NonNegativeInt,
  now: Schema.String,
});
export type UpdateProjectMemoryInput = typeof UpdateProjectMemoryInput.Type;

export const DeleteProjectMemoryInput = Schema.Struct({
  projectId: ProjectId,
  memoryId: ProjectMemoryId,
  expectedVersion: PositiveInt,
});
export type DeleteProjectMemoryInput = typeof DeleteProjectMemoryInput.Type;

export interface ProjectMemoryPage {
  readonly items: ReadonlyArray<ProjectMemory>;
  readonly truncated: boolean;
}

export type ProjectMemoryInsertOutcome =
  | { readonly status: "applied"; readonly record: ProjectMemory }
  | { readonly status: "project-missing" }
  | { readonly status: "origin-invalid" };

export type ProjectMemoryWriteOutcome =
  | { readonly status: "applied"; readonly record: ProjectMemory }
  | { readonly status: "not-found" }
  | { readonly status: "conflict"; readonly currentVersion: number };

export type ProjectMemoryDeleteOutcome =
  | { readonly status: "applied" }
  | { readonly status: "not-found" }
  | { readonly status: "conflict"; readonly currentVersion: number };

export class ProjectMemoryRepository extends Context.Service<
  ProjectMemoryRepository,
  {
    readonly insert: (
      input: InsertProjectMemoryInput,
    ) => Effect.Effect<ProjectMemoryInsertOutcome, ProjectMemoryRepositoryError>;
    readonly getById: (
      input: GetProjectMemoryInput,
    ) => Effect.Effect<Option.Option<ProjectMemory>, ProjectMemoryRepositoryError>;
    readonly listForProject: (
      input: ListProjectMemoriesInput,
    ) => Effect.Effect<ProjectMemoryPage, ProjectMemoryRepositoryError>;
    readonly search: (
      input: SearchProjectMemoriesInput,
    ) => Effect.Effect<ProjectMemoryPage, ProjectMemoryRepositoryError>;
    readonly update: (
      input: UpdateProjectMemoryInput,
    ) => Effect.Effect<ProjectMemoryWriteOutcome, ProjectMemoryRepositoryError>;
    readonly delete: (
      input: DeleteProjectMemoryInput,
    ) => Effect.Effect<ProjectMemoryDeleteOutcome, ProjectMemoryRepositoryError>;
  }
>()("t3/persistence/ProjectMemories/ProjectMemoryRepository") {}

const ProjectMemoryDbRow = Schema.Struct({
  memoryRowid: Schema.Int,
  memoryId: ProjectMemoryId,
  projectId: ProjectId,
  kind: ProjectMemoryKind,
  title: Schema.String,
  body: Schema.String,
  version: PositiveInt,
  originType: Schema.Literals(["manual", "message"]),
  originThreadId: Schema.NullOr(ThreadId),
  originMessageId: Schema.NullOr(MessageId),
  validUntil: Schema.NullOr(Schema.String),
  estimatedTokens: NonNegativeInt,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ProjectMemoryRawDbRow = Schema.Struct({
  memoryRowid: Schema.Unknown,
  memoryId: Schema.Unknown,
  projectId: Schema.Unknown,
  kind: Schema.Unknown,
  title: Schema.Unknown,
  body: Schema.Unknown,
  version: Schema.Unknown,
  originType: Schema.Unknown,
  originThreadId: Schema.Unknown,
  originMessageId: Schema.Unknown,
  validUntil: Schema.Unknown,
  estimatedTokens: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const decodeProjectMemoryDbRow = Schema.decodeUnknownEffect(ProjectMemoryDbRow);

// Provenance consistency is enforced by the table CHECK, so reaching this
// branch means a row was written outside the repository — a decode-level
// failure, never a silent rewrite to `manual`.
const toProjectMemory = (
  row: typeof ProjectMemoryDbRow.Type,
): Effect.Effect<ProjectMemory, PersistenceDecodeError> => {
  const origin: ProjectMemoryOrigin | null =
    row.originType === "manual"
      ? { type: "manual" }
      : row.originThreadId !== null && row.originMessageId !== null
        ? { type: "message", threadId: row.originThreadId, messageId: row.originMessageId }
        : null;
  if (origin === null) {
    return Effect.fail(
      new PersistenceDecodeError({
        operation: "ProjectMemoryRepository.decodeRow",
        issue: "message-origin row missing its source ids",
        correlation: { memoryId: row.memoryId },
      }),
    );
  }
  return Effect.succeed({
    memoryId: row.memoryId,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    body: row.body,
    version: row.version,
    origin,
    validUntil: row.validUntil,
    estimatedTokens: row.estimatedTokens,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
};

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): ProjectMemoryRepositoryError =>
    // Persistence errors raised inside a transaction (e.g. the provenance
    // consistency check) keep their tag; only raw driver/schema failures are
    // wrapped.
    isPersistenceError(cause)
      ? cause
      : Schema.isSchemaError(cause)
        ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
        : new PersistenceSqlError({
            operation: sqlOperation,
            ...(correlation === undefined ? {} : { correlation }),
            cause,
          });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const returningMemoryColumns = sql`
    memory_rowid AS "memoryRowid",
    memory_id AS "memoryId",
    project_id AS "projectId",
    kind AS "kind",
    title AS "title",
    body AS "body",
    version AS "version",
    origin_type AS "originType",
    origin_thread_id AS "originThreadId",
    origin_message_id AS "originMessageId",
    valid_until AS "validUntil",
    estimated_tokens AS "estimatedTokens",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const memoryColumns = sql`
    m.memory_rowid AS "memoryRowid",
    m.memory_id AS "memoryId",
    m.project_id AS "projectId",
    m.kind AS "kind",
    m.title AS "title",
    m.body AS "body",
    m.version AS "version",
    m.origin_type AS "originType",
    m.origin_thread_id AS "originThreadId",
    m.origin_message_id AS "originMessageId",
    m.valid_until AS "validUntil",
    m.estimated_tokens AS "estimatedTokens",
    m.created_at AS "createdAt",
    m.updated_at AS "updatedAt"
  `;
  // Reads hide rows whose project row was raw-deleted from the projection —
  // only the tombstone trigger may remove memory data, so orphans surface as
  // "no memories" rather than errors or destructive cleanup.
  const liveProjectClause = sql`
    EXISTS (
      SELECT 1 FROM projection_projects p
      WHERE p.project_id = m.project_id AND p.deleted_at IS NULL
    )
  `;
  // The same liveness check on the row being mutated, used inside write
  // statements so tombstone ordering is decided inside the statement itself —
  // a preflight read could go stale between statements.
  const liveProjectFor = (projectId: string) => sql`
    EXISTS (
      SELECT 1 FROM projection_projects p
      WHERE p.project_id = ${projectId} AND p.deleted_at IS NULL
    )
  `;
  const messageProvenanceFor = (input: {
    readonly projectId: string;
    readonly threadId: string;
    readonly messageId: string;
  }) => sql`
    EXISTS (
      SELECT 1
      FROM projection_thread_messages msg
      JOIN projection_threads t ON t.thread_id = msg.thread_id
      WHERE msg.message_id = ${input.messageId}
        AND msg.thread_id = ${input.threadId}
        AND t.project_id = ${input.projectId}
        AND t.deleted_at IS NULL
    )
  `;

  const decodeRows = (
    rows: ReadonlyArray<typeof ProjectMemoryRawDbRow.Type>,
    operation: string,
    correlation?: PersistenceErrorCorrelation,
  ) =>
    Effect.forEach(rows, (raw) =>
      decodeProjectMemoryDbRow(raw).pipe(
        Effect.flatMap(toProjectMemory),
        Effect.mapError((cause) =>
          Schema.isSchemaError(cause)
            ? PersistenceDecodeError.fromSchemaError(operation, cause, correlation)
            : cause,
        ),
      ),
    );

  const getMemoryRowById = SqlSchema.findOneOption({
    Request: GetProjectMemoryInput,
    Result: ProjectMemoryRawDbRow,
    execute: ({ projectId, memoryId }) =>
      sql`
        SELECT ${memoryColumns}
        FROM project_memories m
        WHERE m.project_id = ${projectId}
          AND m.memory_id = ${memoryId}
          AND ${liveProjectClause}
      `,
  });

  const listMemoryRowsForProject = SqlSchema.findAll({
    Request: ListProjectMemoriesInput,
    Result: ProjectMemoryRawDbRow,
    execute: ({ projectId, limit }) =>
      sql`
        SELECT ${memoryColumns}
        FROM project_memories m
        WHERE m.project_id = ${projectId}
          AND ${liveProjectClause}
        ORDER BY m.updated_at DESC, m.memory_rowid DESC
        LIMIT ${limit + 1}
      `,
  });

  const searchMemoryRows = SqlSchema.findAll({
    Request: SearchProjectMemoriesInput,
    Result: ProjectMemoryRawDbRow,
    execute: (input) => {
      const clauses = [
        sql`m.project_id = ${input.projectId}`,
        liveProjectClause,
        ...(input.ftsMatch === null
          ? []
          : [
              sql`m.memory_rowid IN (
                SELECT rowid FROM project_memory_fts
                WHERE project_memory_fts MATCH ${input.ftsMatch}
              )`,
            ]),
        ...input.likePatterns.map(
          (pattern) =>
            sql`(m.title LIKE ${pattern} ESCAPE '!' OR m.body LIKE ${pattern} ESCAPE '!')`,
        ),
      ];
      return sql`
        SELECT ${memoryColumns}
        FROM project_memories m
        WHERE ${sql.and(clauses)}
        ORDER BY m.updated_at DESC, m.memory_rowid DESC
        LIMIT ${input.limit + 1}
      `;
    },
  });

  const insert: ProjectMemoryRepository["Service"]["insert"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          // Liveness and (for message origins) same-project provenance are
          // evaluated inside the INSERT itself: a check-then-write pair could
          // interleave a tombstone between the statements. On zero inserted
          // rows the diagnostic SELECT reports which condition failed — the
          // transaction keeps that read consistent.
          const rows = yield* sql<typeof ProjectMemoryRawDbRow.Type>`
            INSERT INTO project_memories (
              memory_id, project_id, kind, title, body, version,
              origin_type, origin_thread_id, origin_message_id,
              valid_until, estimated_tokens, created_at, updated_at
            )
            SELECT
              ${input.memoryId}, ${input.projectId}, ${input.kind}, ${input.title},
              ${input.body}, 1,
              ${input.origin.type},
              ${input.origin.type === "message" ? input.origin.threadId : null},
              ${input.origin.type === "message" ? input.origin.messageId : null},
              ${input.validUntil}, ${input.estimatedTokens}, ${input.now}, ${input.now}
            WHERE
              ${liveProjectFor(input.projectId)}
              AND ${
                input.origin.type === "manual"
                  ? sql`1 = 1`
                  : messageProvenanceFor({
                      projectId: input.projectId,
                      threadId: input.origin.threadId,
                      messageId: input.origin.messageId,
                    })
              }
            RETURNING ${returningMemoryColumns}
          `;
          const row = rows[0];
          if (row === undefined) {
            const live = yield* sql<{ readonly live: number }>`
              SELECT ${liveProjectFor(input.projectId)} AS "live"
            `;
            return live[0]?.live === 1
              ? ({ status: "origin-invalid" } as const)
              : ({ status: "project-missing" } as const);
          }
          yield* sql`
            INSERT INTO project_memory_fts (rowid, title, body)
            VALUES (${row.memoryRowid}, ${input.title}, ${input.body})
          `;
          const record = yield* decodeProjectMemoryDbRow(row).pipe(Effect.flatMap(toProjectMemory));
          return { status: "applied", record } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectMemoryRepository.insert:query",
            "ProjectMemoryRepository.insert:decodeRow",
            { memoryId: input.memoryId },
          ),
        ),
      );

  const getById: ProjectMemoryRepository["Service"]["getById"] = (input) =>
    getMemoryRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectMemoryRepository.getById:query",
          "ProjectMemoryRepository.getById:decodeRows",
          { memoryId: input.memoryId },
        ),
      ),
      Effect.flatMap((rowOption) =>
        Option.match(rowOption, {
          onNone: () => Effect.succeedNone,
          onSome: (raw) =>
            decodeProjectMemoryDbRow(raw).pipe(
              Effect.flatMap(toProjectMemory),
              Effect.mapError((cause) =>
                Schema.isSchemaError(cause)
                  ? PersistenceDecodeError.fromSchemaError(
                      "ProjectMemoryRepository.getById:decodeRow",
                      cause,
                      { memoryId: input.memoryId },
                    )
                  : cause,
              ),
              Effect.map(Option.some),
            ),
        }),
      ),
    );

  const listForProject: ProjectMemoryRepository["Service"]["listForProject"] = (input) =>
    listMemoryRowsForProject(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectMemoryRepository.listForProject:query",
          "ProjectMemoryRepository.listForProject:decodeRows",
          { projectId: input.projectId },
        ),
      ),
      Effect.flatMap((rows) =>
        decodeRows(rows, "ProjectMemoryRepository.listForProject:decodeRows", {
          projectId: input.projectId,
        }).pipe(
          Effect.map((records) => ({
            items: records.slice(0, input.limit),
            truncated: records.length > input.limit,
          })),
        ),
      ),
    );

  const search: ProjectMemoryRepository["Service"]["search"] = (input) =>
    searchMemoryRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectMemoryRepository.search:query",
          "ProjectMemoryRepository.search:decodeRows",
          { projectId: input.projectId },
        ),
      ),
      Effect.flatMap((rows) =>
        decodeRows(rows, "ProjectMemoryRepository.search:decodeRows", {
          projectId: input.projectId,
        }).pipe(
          Effect.map((records) => ({
            items: records.slice(0, input.limit),
            truncated: records.length > input.limit,
          })),
        ),
      ),
    );

  const update: ProjectMemoryRepository["Service"]["update"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* sql<{
            readonly memoryRowid: number;
            readonly version: number;
          }>`
            SELECT memory_rowid AS "memoryRowid", version AS "version"
            FROM project_memories
            WHERE project_id = ${input.projectId} AND memory_id = ${input.memoryId}
          `;
          const row = current[0];
          if (row === undefined) {
            return { status: "not-found" } as const;
          }
          if (row.version !== input.expectedVersion) {
            return { status: "conflict", currentVersion: row.version } as const;
          }
          // The live-project guard rides on the write itself so a tombstone
          // cannot interleave between the check and the mutation.
          const updated = yield* sql<typeof ProjectMemoryRawDbRow.Type>`
            UPDATE project_memories
            SET title = ${input.title},
                body = ${input.body},
                kind = ${input.kind},
                valid_until = ${input.validUntil},
                estimated_tokens = ${input.estimatedTokens},
                version = version + 1,
                updated_at = ${input.now}
            WHERE memory_rowid = ${row.memoryRowid}
              AND version = ${input.expectedVersion}
              AND ${liveProjectFor(input.projectId)}
            RETURNING ${returningMemoryColumns}
          `;
          const updatedRow = updated[0];
          if (updatedRow === undefined) {
            // The project tombstoned between the pre-check and the write, or
            // the row lost a version race. Re-read inside the transaction to
            // report whichever actually happened.
            const raced = yield* sql<{ readonly version: number }>`
              SELECT version FROM project_memories WHERE memory_rowid = ${row.memoryRowid}
            `;
            return raced[0] === undefined || raced[0].version === input.expectedVersion
              ? ({ status: "not-found" } as const)
              : ({ status: "conflict", currentVersion: raced[0].version } as const);
          }
          // Row and index move together or not at all; contentless_delete
          // tables only accept ordinary DELETEs.
          yield* sql`
            DELETE FROM project_memory_fts WHERE rowid = ${row.memoryRowid}
          `;
          yield* sql`
            INSERT INTO project_memory_fts (rowid, title, body)
            VALUES (${row.memoryRowid}, ${input.title}, ${input.body})
          `;
          const record = yield* decodeProjectMemoryDbRow(updatedRow).pipe(
            Effect.flatMap(toProjectMemory),
          );
          return { status: "applied", record } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectMemoryRepository.update:query",
            "ProjectMemoryRepository.update:decodeRow",
            { memoryId: input.memoryId },
          ),
        ),
      );

  const deleteMemory: ProjectMemoryRepository["Service"]["delete"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* sql<{
            readonly memoryRowid: number;
            readonly version: number;
          }>`
            SELECT memory_rowid AS "memoryRowid", version AS "version"
            FROM project_memories
            WHERE project_id = ${input.projectId} AND memory_id = ${input.memoryId}
          `;
          const row = current[0];
          if (row === undefined) {
            return { status: "not-found" } as const;
          }
          if (row.version !== input.expectedVersion) {
            return { status: "conflict", currentVersion: row.version } as const;
          }
          const deleted = yield* sql<{ readonly memoryRowid: number }>`
            DELETE FROM project_memories
            WHERE memory_rowid = ${row.memoryRowid}
              AND version = ${input.expectedVersion}
              AND ${liveProjectFor(input.projectId)}
            RETURNING memory_rowid AS "memoryRowid"
          `;
          if (deleted[0] === undefined) {
            const raced = yield* sql<{ readonly version: number }>`
              SELECT version FROM project_memories WHERE memory_rowid = ${row.memoryRowid}
            `;
            return raced[0] === undefined || raced[0].version === input.expectedVersion
              ? ({ status: "not-found" } as const)
              : ({ status: "conflict", currentVersion: raced[0].version } as const);
          }
          yield* sql`
            DELETE FROM project_memory_fts WHERE rowid = ${row.memoryRowid}
          `;
          return { status: "applied" } as const;
        }),
      )
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "ProjectMemoryRepository.delete:query",
            "ProjectMemoryRepository.delete:decodeRows",
            { memoryId: input.memoryId },
          ),
        ),
      );

  return {
    insert,
    getById,
    listForProject,
    search,
    update,
    delete: deleteMemory,
  } satisfies ProjectMemoryRepository["Service"];
});

export const layer = Layer.effect(ProjectMemoryRepository, make);
