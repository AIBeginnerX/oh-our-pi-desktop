import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { ArrowLeftIcon, SettingsIcon } from "lucide-react";

import { useT } from "../../i18n";
import { useClientSettings } from "../../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useProject } from "../../state/entities";
import { projectMemory } from "../../state/projectMemory";
import { useEnvironmentQuery } from "../../state/query";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { sentItemChange, sentItemStatus } from "./ProjectMemorySentToThread.logic";

/**
 * Read-only list of the project memories this thread's provider has received,
 * from composer references and from the agent's `memory_recall` tool. It carries
 * titles and flags only; memory text never crosses the wire for this view.
 */
export function ProjectMemorySentToThread(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  onBack: () => void;
  /** Called after navigating away so the hosting popover can close. */
  onNavigate: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const result = useEnvironmentQuery(
    projectMemory.sentToThread({
      environmentId: props.environmentId,
      input: { projectId: props.projectId, threadId: props.threadId },
    }),
  );
  const project = useProject(scopeProjectRef(props.environmentId, props.projectId));
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectKey = project
    ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
    : null;
  const items = result.data?.items ?? [];
  return (
    <div className="flex max-h-80 min-w-64 flex-col gap-2" data-memory-sent-to-thread="true">
      <div className="flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t("Back")}
          onClick={props.onBack}
        >
          <ArrowLeftIcon />
        </Button>
        <span className="font-medium text-sm">{t("Sent to this thread")}</span>
      </div>
      {result.data?.held ? (
        <div className="px-2 text-warning-foreground text-xs">
          {t(
            "This thread is on hold because a memory it used changed. Resolve it in the banner above the composer.",
          )}
        </div>
      ) : null}
      {result.isPending && result.data === null ? (
        <div className="px-2 py-3 text-secondary-label text-xs">{t("Reading sent memories…")}</div>
      ) : result.error !== null && result.data === null ? (
        <div className="flex flex-col gap-1 px-2 py-3">
          <div className="text-secondary-label text-xs">{t("Couldn't read what was sent.")}</div>
          <Button variant="outline" size="xs" className="w-fit" onClick={result.refresh}>
            {t("Try again")}
          </Button>
        </div>
      ) : items.length === 0 ? (
        <div className="px-2 py-3 text-secondary-label text-xs">
          {t("No project memory has been sent to this thread.")}
        </div>
      ) : (
        <ul className="flex flex-col overflow-y-auto">
          {items.map((item) => {
            const change = sentItemChange(item);
            return (
              <li
                key={`${item.sentAt}:${item.memoryId}:${item.via}`}
                className="flex flex-col gap-0.5 px-2 py-1.5"
                data-memory-sent-row={item.memoryId}
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {item.title ?? t("Deleted memory")}
                  </span>
                  {change === "deleted" ? (
                    <Badge variant="error" size="sm">
                      {t("Deleted since")}
                    </Badge>
                  ) : change === "edited" ? (
                    <Badge variant="warning" size="sm">
                      {t("Edited since")}
                    </Badge>
                  ) : null}
                </div>
                <div className="text-secondary-label text-2xs">
                  {t(sentItemStatus(item))} · v{item.version} ·{" "}
                  {formatRelativeTimeLabel(item.sentAt)}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {result.data?.truncated ? (
        <div className="px-2 text-secondary-label text-2xs">
          {t("Showing the latest {count} sends.", { count: items.length })}
        </div>
      ) : null}
      <div className="px-2 text-secondary-label text-2xs">
        {t("Content already sent to a provider can't be recalled.")}
      </div>
      {projectKey !== null ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="w-fit"
          onClick={() => {
            props.onNavigate();
            void navigate({ to: "/projects/$projectKey", params: { projectKey } });
          }}
        >
          <SettingsIcon />
          {t("Open project memory settings")}
        </Button>
      ) : null}
    </div>
  );
}
