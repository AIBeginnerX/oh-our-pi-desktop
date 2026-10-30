import * as Effect from "effect/Effect";

import * as CrewService from "../../../crew/CrewService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CrewToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const crew = yield* CrewService.CrewService;
  const scope = McpInvocationContext.requireMcpCapability("crew");

  return CrewToolkit.of({
    crew_roster: () => scope.pipe(Effect.flatMap((invocation) => crew.roster(invocation.threadId))),
    crew_delegate: (input) =>
      scope.pipe(
        Effect.flatMap((invocation) =>
          crew.delegate({
            threadId: invocation.threadId,
            role: input.role,
            task: input.task,
            title: input.title,
            writeScope: input.writeScope,
            verify: input.verify,
            doneWhen: input.doneWhen,
            isolation: input.isolation,
          }),
        ),
      ),
    crew_wait: (input) =>
      scope.pipe(
        Effect.flatMap((invocation) =>
          crew.wait({
            threadId: invocation.threadId,
            taskIds: input.taskIds,
            timeoutSeconds: input.timeoutSeconds,
          }),
        ),
        Effect.map((tasks) => ({ tasks })),
      ),
  });
});

export const CrewToolkitHandlersLive = CrewToolkit.toLayer(make);
