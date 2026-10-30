import { crewTaskActions } from "@t3tools/client-runtime/crew-board";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { WorkflowCrewTask } from "@t3tools/client-runtime/workflow-graph";
import { ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { useT } from "~/i18n";
import { ensureLocalApi } from "~/localApi";
import { crewRetryTask } from "~/state/crewTasks";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/**
 * Stop, Open, and Retry for a crew task on the board. Stop asks first, then interrupts the task's
 * own thread, which ends the task as stopped; Retry asks the server to run it again as a new
 * task. Both lock while a request is in flight so a double click cannot send it twice.
 */
export function CrewTaskActions(props: {
  readonly environmentId: EnvironmentId;
  readonly leadThreadId: ThreadId;
  readonly crew: WorkflowCrewTask;
}) {
  const { environmentId, leadThreadId, crew } = props;
  const t = useT();
  const router = useRouter();
  const interruptThread = useAtomCommand(threadEnvironment.interruptTurn, "stop crew task");
  const retryTask = useAtomCommand(crewRetryTask, "retry crew task");
  const [pending, setPending] = useState<"stop" | "retry" | null>(null);
  const actions = crewTaskActions(crew);
  if (!actions.stop && !actions.open && !actions.retry) return null;
  const crewThreadId = crew.threadId === undefined ? undefined : ThreadId.make(crew.threadId);

  const run = async (action: "stop" | "retry", request: () => Promise<unknown>) => {
    setPending(action);
    try {
      await request();
    } finally {
      setPending(null);
    }
  };
  const confirmedStop = async () =>
    ensureLocalApi().dialogs.confirm(
      [t("Stop this task?"), t("It stops where it is. You can retry it afterwards.")].join("\n"),
      { variant: "destructive" },
    );

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {actions.stop && crewThreadId !== undefined ? (
        <Button
          size="xs"
          variant="destructive-outline"
          disabled={pending !== null}
          onClick={() =>
            void run("stop", async () => {
              if (await confirmedStop()) {
                await interruptThread({ environmentId, input: { threadId: crewThreadId } });
              }
            })
          }
        >
          {pending === "stop" ? <Spinner /> : null}
          {t("Stop")}
        </Button>
      ) : null}
      {actions.retry ? (
        <Button
          size="xs"
          variant="outline"
          disabled={pending !== null}
          onClick={() =>
            void run("retry", () =>
              retryTask({ environmentId, input: { leadThreadId, taskId: crew.taskId } }),
            )
          }
        >
          {pending === "retry" ? <Spinner /> : null}
          {t("Retry")}
        </Button>
      ) : null}
      {actions.open && crewThreadId !== undefined ? (
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(scopeThreadRef(environmentId, crewThreadId)),
            })
          }
        >
          {t("Open")}
        </Button>
      ) : null}
    </div>
  );
}
