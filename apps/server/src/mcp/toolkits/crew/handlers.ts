import type { OrchestrationProjectShell, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as CrewService from "../../../crew/CrewService.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { missingPathsWarning } from "./missingPaths.ts";
import { CrewToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const crew = yield* CrewService.CrewService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = McpInvocationContext.requireMcpCapability("crew");

  /** The directory the member works in: the lead's worktree, else its project root. */
  const workspaceCwd = Effect.fn("CrewToolkit.workspaceCwd")(function* (threadId: ThreadId) {
    const lead = Option.flatten(yield* snapshots.getThreadShellById(threadId).pipe(Effect.option));
    if (Option.isNone(lead)) return undefined;
    const project =
      lead.value.worktreePath === null
        ? Option.flatten(
            yield* snapshots.getProjectShellById(lead.value.projectId).pipe(Effect.option),
          )
        : Option.none<OrchestrationProjectShell>();
    return (
      lead.value.worktreePath ??
      Option.getOrUndefined(Option.map(project, (shell) => shell.workspaceRoot))
    );
  });

  return CrewToolkit.of({
    crew_roster: () => scope.pipe(Effect.flatMap((invocation) => crew.roster(invocation.threadId))),
    crew_delegate: (input) =>
      scope.pipe(
        Effect.flatMap((invocation) =>
          crew
            .delegate({
              threadId: invocation.threadId,
              role: input.role,
              task: input.task,
              title: input.title,
              writeScope: input.writeScope,
              verify: input.verify,
              doneWhen: input.doneWhen,
              isolation: input.isolation,
              size: input.size,
              differentFrom: input.differentFrom,
              todos: input.todos,
              why: input.why,
            })
            .pipe(
              Effect.flatMap((delegated) =>
                Effect.gen(function* () {
                  const cwd = yield* workspaceCwd(invocation.threadId);
                  const extra =
                    cwd === undefined
                      ? undefined
                      : yield* missingPathsWarning(fileSystem, path, cwd, {
                          task: input.task,
                          verify: input.verify,
                          todos: input.todos,
                          writeScope: input.writeScope,
                        });
                  if (extra === undefined) return delegated;
                  return {
                    ...delegated,
                    warning:
                      delegated.warning === undefined ? extra : `${delegated.warning}\n${extra}`,
                  };
                }),
              ),
            ),
        ),
      ),
    crew_todo_check: (input) =>
      scope.pipe(
        Effect.flatMap((invocation) =>
          crew.checkTodo({
            threadId: invocation.threadId,
            todoId: input.todoId,
            status: input.status,
            note: input.note,
          }),
        ),
      ),
    crew_add_todos: (input) =>
      scope.pipe(
        Effect.flatMap((invocation) =>
          crew.addTodos({
            threadId: invocation.threadId,
            taskId: input.taskId,
            todos: input.todos,
          }),
        ),
      ),
    crew_stop: (input) =>
      scope.pipe(
        Effect.flatMap((invocation) =>
          input.taskId === undefined && input.all !== true
            ? Effect.fail(new CrewService.CrewError({ reason: "Give a taskId, or all: true." }))
            : crew.stop({ threadId: invocation.threadId, taskId: input.taskId, why: input.why }),
        ),
      ),
    crew_wait: (input) =>
      scope.pipe(
        Effect.flatMap((invocation) =>
          crew.wait({
            threadId: invocation.threadId,
            taskIds: input.taskIds,
            timeoutSeconds: input.timeoutSeconds,
            providerInstanceId: invocation.providerInstanceId,
          }),
        ),
        Effect.map((tasks) => ({ tasks })),
      ),
  });
});

export const CrewToolkitHandlersLive = CrewToolkit.toLayer(make);
