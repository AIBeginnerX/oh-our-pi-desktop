import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CorrelationId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import { projectThreadDetailSnapshot } from "../ActivityPayloadProjection.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";

const layer = OrchestrationProjectionPipelineLive.pipe(
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tool-updates-test-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const threadId = ThreadId.make("thread-tool-updates");
const turnId = TurnId.make("turn-tool-updates");
const at = (second: number) => `2026-03-01T00:00:${String(second).padStart(2, "0")}.000Z`;

it.layer(layer)("ProjectionPipeline superseded tool.updated pruning", (it) => {
  it.effect("drops updates once the call completes and keeps in-flight updates", () =>
    Effect.gen(function* () {
      const pipeline = yield* OrchestrationProjectionPipeline;
      const eventStore = yield* OrchestrationEventStore;
      const activities = yield* ProjectionThreadActivityRepository;
      let counter = 0;
      const append = (event: Omit<Parameters<typeof eventStore.append>[0], never>) =>
        eventStore.append(event).pipe(Effect.flatMap((saved) => pipeline.projectEvent(saved)));
      const base = (type: string) => {
        counter += 1;
        return {
          type,
          eventId: EventId.make(`evt-tool-updates-${counter}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: at(counter),
          commandId: CommandId.make(`cmd-tool-updates-${counter}`),
          causationEventId: null,
          correlationId: CorrelationId.make(`cmd-tool-updates-${counter}`),
          metadata: {},
        } as const;
      };

      yield* append({
        ...base("project.created"),
        aggregateKind: "project",
        aggregateId: ProjectId.make("project-tool-updates"),
        payload: {
          projectId: ProjectId.make("project-tool-updates"),
          title: "Project",
          workspaceRoot: "/tmp/project-tool-updates",
          defaultModelSelection: null,
          scripts: [],
          createdAt: at(0),
          updatedAt: at(0),
        },
      } as never);
      yield* append({
        ...base("thread.created"),
        payload: {
          threadId,
          projectId: ProjectId.make("project-tool-updates"),
          title: "Thread",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: at(0),
          updatedAt: at(0),
        },
      } as never);

      const raw: Array<{
        id: string;
        tone: "tool";
        kind: string;
        summary: string;
        payload: unknown;
        turnId: TurnId;
        createdAt: string;
      }> = [];
      const appendTool = (id: string, kind: string, toolCallId: string, extra = {}) => {
        const activity = {
          id: EventId.make(id),
          tone: "tool" as const,
          kind,
          summary: "Run command",
          payload: { toolCallId, ...extra },
          turnId,
          createdAt: at(raw.length + 10),
        };
        raw.push(activity);
        return append({
          ...base("thread.activity-appended"),
          payload: { threadId, activity },
        } as never);
      };

      yield* appendTool("a-1", "tool.started", "A");
      yield* appendTool("a-2", "tool.updated", "A", { detail: "step 1" });
      yield* appendTool("b-1", "tool.started", "B");
      yield* appendTool("a-3", "tool.updated", "A", { detail: "step 2" });
      yield* appendTool("b-2", "tool.updated", "B", { detail: "still running" });

      // In flight: nothing is superseded yet.
      const inFlight = yield* activities.listByThreadId({ threadId });
      assert.deepEqual(
        inFlight.map((row) => row.activityId),
        ["a-1", "a-2", "b-1", "a-3", "b-2"],
      );

      yield* appendTool("a-4", "tool.completed", "A", { detail: "done" });

      const after = yield* activities.listByThreadId({ threadId });
      assert.deepEqual(
        after.map((row) => row.activityId),
        ["a-1", "b-1", "b-2", "a-4"],
      );

      // Clients see the same activity list with or without the deleted rows.
      const view = (rows: ReadonlyArray<{ readonly [key: string]: unknown }>) =>
        projectThreadDetailSnapshot({
          thread: { messages: [], activities: rows },
        } as unknown as OrchestrationThreadDetailSnapshot).thread.activities;
      const withDeleted = view(raw);
      const withoutDeleted = view(
        after.map((row) => ({
          id: row.activityId,
          tone: row.tone,
          kind: row.kind,
          summary: row.summary,
          payload: row.payload,
          turnId: row.turnId,
          createdAt: row.createdAt,
        })),
      );
      assert.deepEqual(withoutDeleted, withDeleted);
    }),
  );
});
