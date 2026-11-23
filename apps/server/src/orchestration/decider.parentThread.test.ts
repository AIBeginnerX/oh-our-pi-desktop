import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("crew sub-task parent link", (it) => {
  it.effect("carries the parent link and refuses to rewind a member", () =>
    Effect.gen(function* () {
      const createdAt = "2026-10-22T10:00:00.000Z";
      const projectId = ProjectId.make("project-1");
      const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
        sequence: 1,
        eventId: EventId.make("event-project-created"),
        aggregateKind: "project",
        aggregateId: projectId,
        type: "project.created",
        occurredAt: createdAt,
        commandId: CommandId.make("command-project-created"),
        causationEventId: null,
        correlationId: CommandId.make("command-project-created"),
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt,
          updatedAt: createdAt,
        },
      });
      const lead = ThreadId.make("lead");
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("command-create-worker"),
          threadId: ThreadId.make("worker"),
          projectId,
          title: "Crew Worker · Research",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          parentThreadId: lead,
          createdAt,
        },
        readModel,
      });
      const created = (Array.isArray(event) ? event : [event]).find(
        (planned) => planned.type === "thread.created",
      );
      expect(created).toMatchObject({ payload: { parentThreadId: lead } });
      if (created === undefined) return;
      const next = yield* projectEvent(readModel, { ...created, sequence: 2 });
      expect(next.threads.find((thread) => thread.id === "worker")?.parentThreadId).toBe(lead);
      for (const type of ["thread.conversation.revert", "thread.checkpoint.revert"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type,
            commandId: CommandId.make(`revert-member-${type}`),
            threadId: ThreadId.make("worker"),
            turnCount: 0,
            createdAt,
          },
          readModel: next,
        }).pipe(Effect.result);
        expect.soft(result, type).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OrchestrationCommandInvariantError",
            detail:
              "A crew member's conversation can't be rewound, because its crew task depends on those turns. Nothing was changed.",
          },
        });
      }
      const rewind = yield* decideOrchestrationCommand({
        command: {
          type: "thread.conversation.revert",
          commandId: CommandId.make("revert-independent"),
          threadId: ThreadId.make("worker"),
          turnCount: 0,
          createdAt,
        },
        readModel: {
          ...next,
          threads: next.threads.map((thread) => ({ ...thread, parentThreadId: null })),
        },
      });
      expect(rewind).toMatchObject({
        type: "thread.checkpoint-revert-requested",
        payload: { restoreFiles: false },
      });
    }),
  );
});
