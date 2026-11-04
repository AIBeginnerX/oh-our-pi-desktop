import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { memo } from "react";
import { cn } from "~/lib/utils";
import { crewSubTaskLabel } from "./Sidebar.logic";

/**
 * Crew sub-task threads folded under one line: under the thread that delegated them, or in the
 * "earlier crew tasks" group. The group opens on demand and stays open while one of its threads
 * is the open thread, so the selection is never hidden.
 */
export const EARLIER_CREW_TASKS_GROUP = "earlier-crew-tasks";

export const SidebarCrewTasks = memo(function SidebarCrewTasks(props: {
  readonly label: string;
  readonly tasks: readonly EnvironmentThreadShell[];
  readonly activeKey: string | null;
  readonly nested: boolean;
  /** Open-state lives in the sidebar so keyboard navigation can follow the open groups. */
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpen: (threadRef: ScopedThreadRef) => void;
}) {
  const keyOf = (task: EnvironmentThreadShell) =>
    scopedThreadKey(scopeThreadRef(task.environmentId, task.id));
  const open = props.expanded || props.tasks.some((task) => keyOf(task) === props.activeKey);
  const running = props.tasks.filter(
    (task) => task.session?.status === "running" || task.session?.status === "starting",
  ).length;
  return (
    <div className={cn("flex flex-col", props.nested ? "pl-7 pb-0.5" : "pt-1")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={props.onToggle}
        className="flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-xs text-sidebar-muted-foreground/70 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-3 shrink-0 transition-transform", !open && "-rotate-90")}
        />
        <span className="truncate">
          {props.label} · {props.tasks.length}
          {running > 0 ? ` · ${running} running` : ""}
        </span>
      </button>
      {open
        ? props.tasks.map((task) => {
            const key = keyOf(task);
            return (
              <button
                key={key}
                type="button"
                aria-current={key === props.activeKey ? "page" : undefined}
                onClick={() => props.onOpen(scopeThreadRef(task.environmentId, task.id))}
                className={cn(
                  "flex h-6 cursor-pointer items-center rounded-md pr-2 pl-6 text-left text-xs text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                  key === props.activeKey && "bg-sidebar-row-active text-sidebar-foreground",
                )}
              >
                <span className="truncate">{crewSubTaskLabel(task.title)}</span>
              </button>
            );
          })
        : null}
    </div>
  );
});
