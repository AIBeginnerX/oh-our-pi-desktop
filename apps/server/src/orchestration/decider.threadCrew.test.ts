import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CrewThreadOverride,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const at = "2026-11-03T10:00:00.000Z";
const projectId = ProjectId.make("project-1");
const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };

const run = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.gen(function* () {
    const decided = yield* decideOrchestrationCommand({ command, readModel });
    let next = readModel;
    for (const event of Array.isArray(decided) ? decided : [decided]) {
      next = yield* projectEvent(next, { ...event, sequence: next.snapshotSequence + 1 });
    }
    return next;
  });

const createThread = (id: string, crew?: CrewThreadOverride): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`command-create-${id}`),
  threadId: ThreadId.make(id),
  projectId,
  title: id,
  modelSelection: codex,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  ...(crew === undefined ? {} : { crew }),
  createdAt: at,
});

const setCrew = (id: string, crew: CrewThreadOverride | null): OrchestrationCommand => ({
  type: "thread.crew.set",
  commandId: CommandId.make(`command-crew-${id}-${crew === null ? "reset" : JSON.stringify(crew)}`),
  threadId: ThreadId.make(id),
  crew,
  createdAt: at,
});

const crewOf = (readModel: OrchestrationReadModel, id: string) =>
  readModel.threads.find((thread) => thread.id === id)?.crew;

const withProject = projectEvent(createEmptyReadModel(at), {
  sequence: 1,
  eventId: EventId.make("event-project-created"),
  aggregateKind: "project",
  aggregateId: projectId,
  type: "project.created",
  occurredAt: at,
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
    createdAt: at,
    updatedAt: at,
  },
});

it.layer(NodeServices.layer)("thread crew", (it) => {
  it.effect("a thread starts on the default crew and keeps its own once set", () =>
    Effect.gen(function* () {
      let model = yield* withProject;
      model = yield* run(model, createThread("a"));
      expect(crewOf(model, "a")).toBeNull();

      const own: CrewThreadOverride = {
        enabled: true,
        preset: "quality",
        pinned: { worker: codex },
      };
      model = yield* run(model, setCrew("a", own));
      expect(crewOf(model, "a")).toEqual(own);
    }),
  );

  it.effect("changing one thread's crew leaves every other thread alone", () =>
    Effect.gen(function* () {
      let model = yield* withProject;
      model = yield* run(model, createThread("a"));
      model = yield* run(model, createThread("b"));
      model = yield* run(model, setCrew("a", { enabled: true, preset: "speed" }));
      model = yield* run(model, setCrew("b", { enabled: false }));
      model = yield* run(model, setCrew("a", { enabled: true, preset: "budget" }));
      expect(crewOf(model, "a")).toEqual({ enabled: true, preset: "budget" });
      expect(crewOf(model, "b")).toEqual({ enabled: false });
      model = yield* run(model, createThread("c"));
      expect(crewOf(model, "c")).toBeNull();
    }),
  );

  it.effect("a null crew puts the thread back on the default", () =>
    Effect.gen(function* () {
      let model = yield* withProject;
      model = yield* run(model, createThread("a", { enabled: true }));
      expect(crewOf(model, "a")).toEqual({ enabled: true });
      model = yield* run(model, setCrew("a", null));
      expect(crewOf(model, "a")).toBeNull();
    }),
  );

  it.effect("a crew set before the first message comes with the new thread", () =>
    Effect.gen(function* () {
      const model = yield* run(yield* withProject, createThread("a", { preset: "quality" }));
      expect(crewOf(model, "a")).toEqual({ preset: "quality" });
    }),
  );

  it.effect("refuses a thread that does not exist", () =>
    Effect.gen(function* () {
      const result = yield* Effect.exit(
        run(yield* withProject, setCrew("missing", { enabled: true })),
      );
      expect(result._tag).toBe("Failure");
    }),
  );
});
