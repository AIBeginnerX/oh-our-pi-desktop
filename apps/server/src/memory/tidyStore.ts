import { PROJECT_MEMORY_TIDY_PENDING_MAX } from "@t3tools/contracts";
import type {
  ProjectId,
  ProjectMemoryId,
  ProjectMemoryTidyAction,
  ProjectMemoryTidyId,
} from "@t3tools/contracts";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

export interface TidyRecord {
  tidyId: ProjectMemoryTidyId;
  projectId: ProjectId;
  action: ProjectMemoryTidyAction;
  title: string | null;
  body: string | null;
  reason: string;
  memories: ReadonlyArray<{ memoryId: ProjectMemoryId; version: number }>;
  dreamed: boolean;
  createdAt: string;
}
export const tidyStore = (sql: SqlClient.SqlClient) => ({
  list: (projectId: ProjectId) =>
    sql<Omit<TidyRecord, "memories" | "dreamed"> & { memoriesJson: string; dreamed: number }>`
    SELECT tidy_id AS "tidyId", project_id AS "projectId", action, title, body, reason,
      memories_json AS "memoriesJson", dreamed, created_at AS "createdAt"
    FROM project_memory_tidy_suggestions WHERE project_id = ${projectId} ORDER BY created_at, tidy_id
  `.pipe(
      Effect.map((rows) =>
        rows.map(({ memoriesJson, dreamed, ...row }) => ({
          ...row,
          dreamed: dreamed === 1,
          memories: JSON.parse(memoriesJson) as TidyRecord["memories"],
        })),
      ),
    ),
  remove: (projectId: ProjectId, tidyId: ProjectMemoryTidyId) =>
    sql`DELETE FROM project_memory_tidy_suggestions WHERE project_id = ${projectId} AND tidy_id = ${tidyId}`,
  insert: (row: TidyRecord) => sql`INSERT INTO project_memory_tidy_suggestions
    (tidy_id, project_id, action, title, body, reason, memories_json, dreamed, created_at)
    SELECT ${row.tidyId}, ${row.projectId}, ${row.action}, ${row.title}, ${row.body}, ${row.reason}, ${JSON.stringify(row.memories)}, ${row.dreamed ? 1 : 0}, ${row.createdAt}
    WHERE EXISTS (SELECT 1 FROM projection_projects WHERE project_id = ${row.projectId} AND deleted_at IS NULL)
      AND (SELECT COUNT(*) FROM project_memory_tidy_suggestions WHERE project_id = ${row.projectId}) < ${PROJECT_MEMORY_TIDY_PENDING_MAX}`,
});
