import {
  DEFAULT_THREAD_GOAL_MAX_CONTINUES,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadGoalProgress, type ThreadGoalStatus } from "@t3tools/shared/threadGoal";
import { CheckIcon, TargetIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { cn, randomUUID } from "~/lib/utils";
import { useThreadDetail } from "~/state/entities";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";
import { Textarea } from "../ui/textarea";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";

const CONTINUE_LIMITS = [3, 5, 10] as const;

const STATUS_LABEL: Record<ThreadGoalStatus, string> = {
  working: "Working",
  met: "Done",
  blocked: "Blocked",
  exhausted: "Stopped",
};

/**
 * The thread's goal at a glance, and the place to set or stop it. While a goal is open OOP
 * continues the chat after each turn until the agent reports it done or blocked, or the
 * automatic continuations run out.
 */
export function GoalChip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly disabled?: boolean;
}) {
  const goals = useEnvironmentSettings(props.environmentId, (value) => value.threadGoals);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const goal = goals[props.threadId];
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const activities = useThreadDetail(threadRef)?.activities;
  const progress = useMemo(
    () => (goal === undefined ? null : threadGoalProgress(goal, activities ?? [])),
    [goal, activities],
  );
  const [text, setText] = useState("");
  const [maxContinues, setMaxContinues] = useState<number>(DEFAULT_THREAD_GOAL_MAX_CONTINUES);

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    setText(goal?.text ?? "");
    setMaxContinues(goal?.maxContinues ?? DEFAULT_THREAD_GOAL_MAX_CONTINUES);
  };
  const save = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    updateSettings({
      threadGoals: {
        ...goals,
        [props.threadId]: {
          id: randomUUID(),
          text: trimmed,
          maxContinues,
          active: true,
          setAt: new Date().toISOString(),
        },
      },
    });
  };
  const stop = () => {
    const { [props.threadId]: _stopped, ...rest } = goals;
    updateSettings({ threadGoals: rest });
  };

  const status = progress?.status;
  return (
    <Popover onOpenChange={onOpenChange}>
      <PopoverTrigger
        disabled={props.disabled}
        render={
          <ComposerControl
            aria-label={goal === undefined ? "Set a goal for this chat" : "Change this chat's goal"}
            className="shrink-0"
          />
        }
      >
        <ComposerControlIcon icon={status === "met" ? CheckIcon : TargetIcon} />
        <span
          className={cn(
            "text-xs",
            goal === undefined ? "text-muted-foreground" : "text-foreground",
            status === "blocked" && "text-warning",
          )}
        >
          {goal === undefined || progress === null
            ? "Goal"
            : status === "working"
              ? `Goal ${progress.continues}/${goal.maxContinues}`
              : `Goal: ${STATUS_LABEL[progress.status]}`}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-3">
          <div>
            <PopoverTitle>Chat goal</PopoverTitle>
            <div className="text-xs text-muted-foreground">
              OOP keeps this chat going after each turn until the agent reports the goal done or
              needs you.
            </div>
          </div>

          {goal !== undefined && progress !== null ? (
            <div className="rounded-md border border-border/70 px-2.5 py-2 text-xs">
              <span className="font-medium">{STATUS_LABEL[progress.status]}</span>
              <span className="text-muted-foreground">
                {` · ${progress.continues} of ${goal.maxContinues} automatic continuations used`}
              </span>
              {progress.blockedReason ? (
                <div className="mt-1 text-muted-foreground">{progress.blockedReason}</div>
              ) : null}
            </div>
          ) : null}

          <Textarea
            size="sm"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            placeholder="What should be true when this chat is done?"
            aria-label="Goal"
          />

          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground">Automatic continuations</span>
            <div className="flex gap-1">
              {CONTINUE_LIMITS.map((limit) => (
                <button
                  key={limit}
                  type="button"
                  aria-pressed={maxContinues === limit}
                  onClick={() => setMaxContinues(limit)}
                  className={cn(
                    "rounded-md border px-2 py-0.5 text-2xs transition-colors",
                    maxContinues === limit
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border/70 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {limit}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-2xs text-muted-foreground">
              {goal === undefined ? "Send a message to start." : "Saving restarts the count."}
            </span>
            <div className="flex gap-1">
              {goal !== undefined ? (
                <Button size="xs" variant="ghost-muted" onClick={stop}>
                  Stop goal
                </Button>
              ) : null}
              <Button size="xs" disabled={text.trim().length === 0} onClick={save}>
                {goal === undefined ? "Set goal" : "Save goal"}
              </Button>
            </div>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
