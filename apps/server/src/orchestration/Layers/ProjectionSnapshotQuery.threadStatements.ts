import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  THREAD_DETAIL_ACTIVITY_LIMIT,
  MESSAGE_TRIM_WHITESPACE,
  ProjectionThreadMessageDbRowSchema,
  ProjectionTurnStartMessageDbRowSchema,
  ProjectionThreadProposedPlanDbRowSchema,
  ProjectionThreadPullRequestDbRowSchema,
  ProjectionThreadDbRowSchema,
  ProjectionThreadActivityDbRowSchema,
  ProjectionThreadActivityIdRowSchema,
  ProjectionThreadSessionDbRowSchema,
  ProjectionThreadRuntimeContextDbRowSchema,
  ProjectionCheckpointDbRowSchema,
  ProjectionLatestTurnDbRowSchema,
  ProjectIdLookupInput,
  ProjectionImportedAgentSessionSourcesRowSchema,
  ThreadIdLookupInput,
  TurnStartMessageLookupInput,
  ThreadActivityKindsLookupInput,
  ThreadActivityIdsLookupInput,
  ThreadTurnWindowLookupInput,
  ProjectionTurnWindowRowSchema,
  ThreadTurnRangeLookupInput,
  ProjectionThreadCheckpointContextThreadRowSchema,
  FullThreadDiffContextLookupInput,
  ProjectionFullThreadDiffContextRowSchema,
} from "./ProjectionSnapshotQuery.schemas.ts";

export const makeProjectionThreadStatements = (sql: SqlClient.SqlClient) => {
  const listImportedAgentSessionSourceRows = SqlSchema.findAll({
    Request: ProjectIdLookupInput,
    Result: ProjectionImportedAgentSessionSourcesRowSchema,
    execute: ({ projectId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          runtime.runtime_payload_json AS "runtimePayload"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        INNER JOIN provider_session_runtime AS runtime
          ON runtime.thread_id = threads.thread_id
        WHERE threads.project_id = ${projectId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND EXISTS (
            SELECT 1
            FROM projection_thread_messages AS messages
            WHERE messages.thread_id = threads.thread_id
              AND messages.message_id GLOB 'import:*'
          )
        ORDER BY threads.thread_id ASC
      `,
  });

  const getThreadCheckpointContextThreadRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadCheckpointContextThreadRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  const getActiveThreadRowById = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          title_state_json AS "titleState",
          model_selection_json AS "modelSelection",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          linked_pull_request_json AS "linkedPullRequest",
          branch_pull_request_json AS "branchPullRequest",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          archived_at AS "archivedAt",
          settled_override AS "settledOverride",
          settled_at AS "settledAt",
          unsettled_at AS "unsettledAt",
          snoozed_until AS "snoozedUntil",
          snoozed_at AS "snoozedAt",
          pinned_at AS "pinnedAt",
          pin_order_key AS "pinOrderKey",
          active_order_key AS "activeOrderKey",
          auto_settle_disabled_at AS "autoSettleDisabledAt",
          parent_thread_id AS "parentThreadId",
          crew_json AS "crew",
          title_regeneration_request_id AS "titleRegenerationRequestId",
          title_regeneration_started_at AS "titleRegenerationStartedAt",
          latest_user_message_at AS "latestUserMessageAt",
          pending_approval_count AS "pendingApprovalCount",
          pending_user_input_count AS "pendingUserInputCount",
          has_actionable_proposed_plan AS "hasActionableProposedPlan",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
          AND deleted_at IS NULL
          AND archived_at IS NULL
        LIMIT 1
      `,
  });

  const getThreadRuntimeContextRow = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadRuntimeContextDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          threads.thread_id AS id,
          threads.project_id AS "projectId",
          threads.title,
          threads.title_state_json AS "titleState",
          sessions.thread_id AS "threadId",
          sessions.status,
          sessions.provider_name AS "providerName",
          sessions.provider_instance_id AS "providerInstanceId",
          sessions.runtime_mode AS "runtimeMode",
          sessions.active_turn_id AS "activeTurnId",
          sessions.last_error AS "lastError",
          sessions.updated_at AS "updatedAt"
        FROM projection_threads AS threads
        LEFT JOIN projection_thread_sessions AS sessions
          ON sessions.thread_id = threads.thread_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            id: row.id,
            projectId: row.projectId,
            title: row.title,
            titleState: row.titleState,
            session: row.threadId === null ? null : row,
          })),
        ),
      ),
  });

  const getTurnStartMessageRow = SqlSchema.findOneOption({
    Request: TurnStartMessageLookupInput,
    Result: ProjectionTurnStartMessageDbRowSchema,
    execute: ({ threadId, messageId }) => sql`
      SELECT
        message_id AS "messageId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        role,
        text,
        attachments_json AS "attachments",
        context_json AS "context",
        is_streaming AS "isStreaming",
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        EXISTS (
          SELECT 1
          FROM projection_thread_messages AS other
          WHERE other.thread_id = ${threadId}
            AND other.message_id != ${messageId}
            AND other.role = 'user'
            AND (
              LOWER(TRIM(other.text, ${MESSAGE_TRIM_WHITESPACE})) != '/compact'
              OR COALESCE(json_array_length(other.attachments_json), 0) > 0
            )
        ) AS "hasOtherUserMessages"
      FROM projection_thread_messages
      WHERE thread_id = ${threadId} AND message_id = ${messageId}
      LIMIT 1
    `,
  });

  const listThreadMessageRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const listThreadProposedPlanRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadProposedPlanDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          plan_id AS "planId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          plan_markdown AS "planMarkdown",
          implemented_at AS "implementedAt",
          implementation_thread_id AS "implementationThreadId",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_proposed_plans
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, plan_id ASC
      `,
  });

  const listThreadPullRequestRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadPullRequestDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          host,
          repository,
          number,
          url,
          source,
          linked_at AS "linkedAt",
          snapshot_json AS "snapshot",
          stack_json AS "stack"
        FROM projection_thread_pull_requests
        WHERE thread_id = ${threadId}
        ORDER BY linked_at ASC, number ASC
      `,
  });

  const listThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getUserInputActivityRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, requestId: ApprovalRequestId }),
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, requestId }) => sql`
      SELECT
        activity_id AS "activityId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        tone,
        kind,
        summary,
        payload_json AS "payload",
        sequence,
        created_at AS "createdAt"
      FROM projection_thread_activities
      WHERE thread_id = ${threadId}
        AND kind IN ('user-input.requested', 'user-input.resolved')
        AND json_extract(payload_json, '$.requestId') = ${requestId}
      ORDER BY sequence DESC, created_at DESC, activity_id DESC
      LIMIT 1
    `,
  });

  const listActivityRowsByKind = SqlSchema.findAll({
    Request: Schema.Struct({ kind: Schema.String }),
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ kind }) => sql`
      SELECT
        a.activity_id AS "activityId",
        a.thread_id AS "threadId",
        a.turn_id AS "turnId",
        a.tone,
        a.kind,
        a.summary,
        a.payload_json AS "payload",
        a.sequence,
        a.created_at AS "createdAt"
      FROM projection_thread_activities a
      JOIN projection_threads t ON t.thread_id = a.thread_id
      WHERE a.kind = ${kind}
        AND t.deleted_at IS NULL
        AND t.archived_at IS NULL
      ORDER BY a.created_at ASC, a.activity_id ASC
    `,
  });

  const listThreadActivityIdsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
        ORDER BY
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
      `,
  });

  const listThreadActivityRowsByIds = SqlSchema.findAll({
    Request: ThreadActivityIdsLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ activityIds }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM projection_thread_activities
        -- The selectors already scoped these globally unique ids to the
        -- thread inside this transaction. Keep this as a primary-key lookup.
        WHERE ${sql.in("activity_id", activityIds)}
      `,
  });

  const listThreadActivityRowsByThreadAndKinds = SqlSchema.findAll({
    Request: ThreadActivityKindsLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, activityKinds }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND ${sql.in("kind", activityKinds)}
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const getThreadSessionRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadSessionDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          status,
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          runtime_mode AS "runtimeMode",
          active_turn_id AS "activeTurnId",
          last_error AS "lastError",
          updated_at AS "updatedAt"
        FROM projection_thread_sessions
        WHERE thread_id = ${threadId}
        LIMIT 1
      `,
  });

  const getLatestTurnRowByThread = SqlSchema.findOneOption({
    Request: ThreadIdLookupInput,
    Result: ProjectionLatestTurnDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          turns.thread_id AS "threadId",
          turns.turn_id AS "turnId",
          turns.state,
          turns.requested_at AS "requestedAt",
          turns.started_at AS "startedAt",
          turns.completed_at AS "completedAt",
          turns.assistant_message_id AS "assistantMessageId",
          turns.source_proposed_plan_thread_id AS "sourceProposedPlanThreadId",
          turns.source_proposed_plan_id AS "sourceProposedPlanId"
        FROM projection_threads threads
        JOIN projection_turns turns
          ON turns.thread_id = threads.thread_id
          AND turns.turn_id = threads.latest_turn_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
        LIMIT 1
      `,
  });

  const listCheckpointRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionCheckpointDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          turn_id AS "turnId",
          checkpoint_turn_count AS "checkpointTurnCount",
          checkpoint_ref AS "checkpointRef",
          checkpoint_status AS "status",
          checkpoint_files_json AS "files",
          assistant_message_id AS "assistantMessageId",
          completed_at AS "completedAt"
        FROM projection_turns
        WHERE thread_id = ${threadId}
          AND checkpoint_turn_count IS NOT NULL
        ORDER BY checkpoint_turn_count ASC
      `,
  });

  // Resolves a page of recent turns for a windowed thread detail read. Walks
  // back from the exclusive (beforeAnchorAt, beforeTurnKey) keyset boundary
  // (sentinels "~"/"" mean unbounded, i.e. the first page) until it has seen
  // `userTurnLimit` user-anchored turns — turns whose pending message is a
  // user message; subagent/fan-out turns between them ride along — or hits the
  // `maxRawTurns` ceiling that bounds pathological fan-out. The `candidates`
  // CTE applies the keyset bound and LIMIT before the window functions run;
  // its ORDER BY uses raw columns so the migration-037
  // (thread_id, requested_at, turn_id) index serves both range and order with
  // no temp B-tree — the scan is genuinely bounded by the LIMIT. (Raw
  // turn_id DESC places NULLs exactly where COALESCE-to-'' would, below every
  // real id.) The caller derives the continuation cursor from the oldest
  // returned row.
  // Highest thread-DETAIL event sequence for this thread that the projection
  // has applied (bounded by the global snapshot sequence read in the same
  // transaction). This is the thread-scoped watermark a windowed page carries
  // so clients can defer merging until their live subscription has caught up;
  // the global sequence is not waitable per-thread. The event_type filter
  // must match ws.ts's isThreadDetailEvent exactly: the subscription only
  // delivers these types, so a watermark counting any other event could
  // never be reached by the client and would park the page forever. Served
  // by the event store's (aggregate_kind, stream_id, sequence) index.
  const getThreadEventWatermarkRow = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: ThreadId, maxSequence: Schema.Number }),
    Result: Schema.Struct({ threadSequence: Schema.NullOr(Schema.Number) }),
    execute: ({ threadId, maxSequence }) =>
      sql`
        SELECT MAX(sequence) AS "threadSequence"
        FROM orchestration_events
        WHERE aggregate_kind = 'thread'
          AND stream_id = ${threadId}
          AND sequence <= ${maxSequence}
          AND event_type IN (
            'thread.message-sent',
            'thread.proposed-plan-upserted',
            'thread.activity-appended',
            'thread.turn-diff-completed',
            'thread.reverted',
            'thread.session-set'
          )
      `,
  });

  const listTurnWindowRows = SqlSchema.findAll({
    Request: ThreadTurnWindowLookupInput,
    Result: ProjectionTurnWindowRowSchema,
    execute: ({ threadId, beforeAnchorAt, beforeTurnKey, userTurnLimit, maxRawTurns }) =>
      sql`
        WITH candidates AS (
          SELECT
            turns.requested_at AS anchor_at,
            COALESCE(turns.turn_id, '') AS turn_key,
            turns.pending_message_id
          FROM projection_turns AS turns
          WHERE turns.thread_id = ${threadId}
            AND (
              turns.requested_at < ${beforeAnchorAt}
              OR (
                turns.requested_at = ${beforeAnchorAt}
                AND COALESCE(turns.turn_id, '') < ${beforeTurnKey}
              )
            )
          ORDER BY turns.requested_at DESC, turns.turn_id DESC
          LIMIT ${maxRawTurns}
        ),
        walked AS (
          SELECT
            candidates.anchor_at,
            candidates.turn_key,
            CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END AS is_user_turn,
            SUM(CASE WHEN messages.role = 'user' THEN 1 ELSE 0 END) OVER (
              ORDER BY candidates.anchor_at DESC, candidates.turn_key DESC
            ) AS user_turns_seen
          FROM candidates
          LEFT JOIN projection_thread_messages AS messages
            ON messages.message_id = candidates.pending_message_id
        )
        SELECT
          anchor_at AS "anchorAt",
          turn_key AS "turnKey"
        FROM walked
        WHERE user_turns_seen < ${userTurnLimit}
          OR (user_turns_seen = ${userTurnLimit} AND is_user_turn = 1)
        ORDER BY anchor_at ASC, turn_key ASC
      `,
  });

  // Windowed variants of the two heavy collections. Turn-linked rows are
  // bounded by the page's (anchor, turn key) keyset range over
  // projection_turns; rows with no turn linkage (user messages always, and
  // turnless activities like pre-turn context-window updates) are bounded by
  // the matching turn-anchor time range so they land on the same page as the
  // turns around them. Proposed plans and checkpoints stay unwindowed: they
  // are metadata-scale.
  const listThreadMessageRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadMessageDbRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT
          message_id AS "messageId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          role,
          text,
          attachments_json AS "attachments",
          context_json AS "context",
          is_streaming AS "isStreaming",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM projection_thread_messages
        WHERE thread_id = ${threadId}
          AND (
            turn_id IN (
              SELECT turn_id FROM projection_turns
              WHERE thread_id = ${threadId}
                AND turn_id IS NOT NULL
                AND (
                  requested_at > ${minAnchorAt}
                  OR (
                    requested_at = ${minAnchorAt}
                    AND turn_id >= ${minTurnKey}
                  )
                )
                AND (
                  requested_at < ${beforeAnchorAt}
                  OR (
                    requested_at = ${beforeAnchorAt}
                    AND turn_id < ${beforeTurnKey}
                  )
                )
            )
            OR (
              turn_id IS NULL
              AND created_at >= ${minAnchorAt}
              AND created_at < ${beforeAnchorAt}
            )
          )
        ORDER BY created_at ASC, message_id ASC
      `,
  });

  const pinnedThreadActivityIdsCte = (threadId: string) => sql`
pending_approval_requests AS (
          SELECT request_id, thread_id
          FROM projection_pending_approvals
          WHERE thread_id = ${threadId}
            AND status = 'pending'
        ),
        pending_approval_activities AS (
          SELECT
            activity.activity_id,
            ROW_NUMBER() OVER (
              PARTITION BY pending.request_id
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_approval_requests AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND activity.kind = 'approval.requested'
            AND json_extract(activity.payload_json, '$.requestId') = pending.request_id
        ),
        pending_user_input_thread AS (
          SELECT thread_id
          FROM projection_threads
          WHERE thread_id = ${threadId}
            AND pending_user_input_count > 0
        ),
        user_input_lifecycle AS (
          SELECT
            activity.activity_id,
            activity.kind,
            ROW_NUMBER() OVER (
              PARTITION BY json_extract(activity.payload_json, '$.requestId')
              ORDER BY activity.created_at DESC, activity.activity_id DESC
            ) AS request_order
          FROM pending_user_input_thread AS pending
          CROSS JOIN projection_thread_activities AS activity
          WHERE activity.thread_id = pending.thread_id
            AND (
              activity.kind IN ('user-input.requested', 'user-input.resolved')
              OR (
                activity.kind = 'provider.user-input.respond.failed'
                AND (
                  lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%stale pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user-input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending user input request%'
                  OR lower(COALESCE(json_extract(activity.payload_json, '$.detail'), ''))
                    LIKE '%unknown pending codex user input request%'
                )
              )
            )
            AND json_extract(activity.payload_json, '$.requestId') IS NOT NULL
        ),
        pinned_activity_ids AS (
          SELECT activity_id
          FROM pending_approval_activities
          WHERE request_order = 1
          UNION ALL
          SELECT activity_id
          FROM user_input_lifecycle
          WHERE request_order = 1
            AND kind = 'user-input.requested'
        )
  `;

  // Blocking request payloads must remain available even if they predate the
  // recent activity window. Each CTE returns at most one unresolved row per
  // request, so the merge below stays bounded by actionable work.
  const listPinnedThreadActivityRowsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ${pinnedThreadActivityIdsCte(threadId)}
        SELECT
          activity.activity_id AS "activityId",
          activity.thread_id AS "threadId",
          activity.turn_id AS "turnId",
          activity.tone,
          activity.kind,
          activity.summary,
          activity.payload_json AS "payload",
          activity.sequence,
          activity.created_at AS "createdAt"
        FROM pinned_activity_ids AS pinned
        INNER JOIN projection_thread_activities AS activity
          ON activity.activity_id = pinned.activity_id
        ORDER BY activity.created_at ASC, activity.activity_id ASC
      `,
  });

  const listPinnedThreadActivityIdsByThread = SqlSchema.findAll({
    Request: ThreadIdLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId }) =>
      sql`
        WITH ${pinnedThreadActivityIdsCte(threadId)}
        SELECT activity_id AS "activityId"
        FROM pinned_activity_ids
      `,
  });

  const listThreadActivityRowsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadActivityDbRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT
          activity_id AS "activityId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          tone,
          kind,
          summary,
          payload_json AS "payload",
          sequence,
          created_at AS "createdAt"
        FROM (
          SELECT
            activity_id,
            thread_id,
            turn_id,
            tone,
            kind,
            summary,
            payload_json,
            sequence,
            created_at
          FROM projection_thread_activities
          WHERE thread_id = ${threadId}
            AND (
              turn_id IN (
                SELECT turn_id FROM projection_turns
                WHERE thread_id = ${threadId}
                  AND turn_id IS NOT NULL
                  AND (
                    requested_at > ${minAnchorAt}
                    OR (
                      requested_at = ${minAnchorAt}
                      AND turn_id >= ${minTurnKey}
                    )
                  )
                  AND (
                    requested_at < ${beforeAnchorAt}
                    OR (
                      requested_at = ${beforeAnchorAt}
                      AND turn_id < ${beforeTurnKey}
                    )
                  )
              )
              OR (
                turn_id IS NULL
                AND created_at >= ${minAnchorAt}
                AND created_at < ${beforeAnchorAt}
              )
            )
          ORDER BY
            sequence DESC,
            created_at DESC,
            activity_id DESC
          LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
        ) AS recent_activities
        ORDER BY
          sequence ASC,
          created_at ASC,
          activity_id ASC
      `,
  });

  const listThreadActivityIdsByThreadWindow = SqlSchema.findAll({
    Request: ThreadTurnRangeLookupInput,
    Result: ProjectionThreadActivityIdRowSchema,
    execute: ({ threadId, minAnchorAt, minTurnKey, beforeAnchorAt, beforeTurnKey }) =>
      sql`
        SELECT activity_id AS "activityId"
        FROM projection_thread_activities
        WHERE thread_id = ${threadId}
          AND (
            turn_id IN (
              SELECT turn_id FROM projection_turns
              WHERE thread_id = ${threadId}
                AND turn_id IS NOT NULL
                AND (
                  requested_at > ${minAnchorAt}
                  OR (
                    requested_at = ${minAnchorAt}
                    AND turn_id >= ${minTurnKey}
                  )
                )
                AND (
                  requested_at < ${beforeAnchorAt}
                  OR (
                    requested_at = ${beforeAnchorAt}
                    AND turn_id < ${beforeTurnKey}
                  )
                )
            )
            OR (
              turn_id IS NULL
              AND created_at >= ${minAnchorAt}
              AND created_at < ${beforeAnchorAt}
            )
          )
        ORDER BY
          sequence DESC,
          created_at DESC,
          activity_id DESC
        LIMIT ${THREAD_DETAIL_ACTIVITY_LIMIT}
      `,
  });

  const getFullThreadDiffContextRow = SqlSchema.findOneOption({
    Request: FullThreadDiffContextLookupInput,
    Result: ProjectionFullThreadDiffContextRowSchema,
    execute: ({ threadId, checkpointTurnCount }) =>
      sql`
        SELECT
          threads.thread_id AS "threadId",
          threads.project_id AS "projectId",
          projects.workspace_root AS "workspaceRoot",
          threads.worktree_path AS "worktreePath",
          (
            SELECT MAX(turns.checkpoint_turn_count)
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count IS NOT NULL
          ) AS "latestCheckpointTurnCount",
          (
            SELECT turns.checkpoint_ref
            FROM projection_turns AS turns
            WHERE turns.thread_id = threads.thread_id
              AND turns.checkpoint_turn_count = ${checkpointTurnCount}
            LIMIT 1
          ) AS "toCheckpointRef"
        FROM projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id = ${threadId}
          AND threads.deleted_at IS NULL
        LIMIT 1
      `,
  });

  return {
    listImportedAgentSessionSourceRows,
    getThreadCheckpointContextThreadRow,
    getActiveThreadRowById,
    getThreadRuntimeContextRow,
    getTurnStartMessageRow,
    listThreadMessageRowsByThread,
    listThreadProposedPlanRowsByThread,
    listThreadPullRequestRowsByThread,
    listThreadActivityRowsByThread,
    getUserInputActivityRow,
    listActivityRowsByKind,
    listThreadActivityIdsByThread,
    listThreadActivityRowsByIds,
    listThreadActivityRowsByThreadAndKinds,
    getThreadSessionRowByThread,
    getLatestTurnRowByThread,
    listCheckpointRowsByThread,
    getThreadEventWatermarkRow,
    listTurnWindowRows,
    listThreadMessageRowsByThreadWindow,
    listPinnedThreadActivityRowsByThread,
    listPinnedThreadActivityIdsByThread,
    listThreadActivityRowsByThreadWindow,
    listThreadActivityIdsByThreadWindow,
    getFullThreadDiffContextRow,
  };
};
