import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { TooltipProvider, Tooltip, TooltipTrigger } from "./ui/tooltip";
import { useT } from "../i18n";
import {
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { memo, useEffect, useMemo, useState } from "react";
import { vcsEnvironment } from "../state/vcs";
import { useEnvironmentQuery } from "../state/query";
import { type SidebarThreadSummary } from "../types";
import { type EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { cn } from "~/lib/utils";
import {
  resolveSidebarRowAccessibility,
  useRetainedValue,
  useSidebarRowSubscriptionLease,
} from "./Sidebar.logic";
import { resolveLocalCheckoutBranchMismatch } from "./BranchToolbar.logic";
import { terminalStatusFromRunningIds } from "./ThreadStatusIndicators";
import { ProjectFavicon } from "./ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "./ThreadSearchMatch";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { getTriggerDisplayModelLabel } from "./chat/providerIconUtils";
import { shouldShowInstanceBadge, type ProviderInstanceEntry } from "../providerInstances";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { threadTimeLabel, SidebarThreadTooltip, EMPTY_PROVIDER_ENTRIES } from "./Sidebar.parts";

export const SidebarSearchResultRow = memo(function SidebarSearchResultRow(props: {
  thread: SidebarThreadSummary;
  project: EnvironmentProject | null;
  projectDisplayName: string | null;
  environmentLabel: string | null;
  environmentMachine: EnvironmentMachineKind;
  providerEntryByInstanceId: ReadonlyMap<string, ProviderInstanceEntry>;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  searchMatch: EnvironmentThreadSearchMatch | null;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const { thread } = props;
  const accessibility = resolveSidebarRowAccessibility({
    title: thread.title,
    statusLabel: null,
    projectDisplayName: props.projectDisplayName,
    isActive: props.isRouteActive,
  });
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const { leaseLiveStatus, rowRef } = useSidebarRowSubscriptionLease(
    props.isHighlighted || props.isRouteActive,
  );
  // Same details tooltip as the regular rows: a search hit is still a thread,
  // and the hover card is how you disambiguate identically-titled results.
  const gitCwd = thread.worktreePath ?? props.project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    leaseLiveStatus && (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const visibleGitStatus = useRetainedValue(
    JSON.stringify([thread.environmentId, gitCwd]),
    gitStatus.data,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: visibleGitStatus?.refName ?? null,
  });
  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry = props.providerEntryByInstanceId.get(modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null &&
    shouldShowInstanceBadge(providerEntry, props.providerEntryByInstanceId.values());
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const fileDropHandlers = useMemo(
    () =>
      makeWorkspaceFileDropHandlers({
        setDragActive: setIsFileDragOver,
        addFiles: (files) => {
          props.onFileDropThreads(threadRef, files);
        },
        addFolders: () => {},
      }),
    [props.onFileDropThreads, threadRef],
  );
  useEffect(() => {
    if (!isFileDragOver) return;
    const clearFileDrag = () => setIsFileDragOver(false);
    window.addEventListener("dragend", clearFileDrag);
    return () => window.removeEventListener("dragend", clearFileDrag);
  }, [isFileDragOver]);
  return (
    <li role="presentation" className="list-none" {...fileDropHandlers}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              ref={rowRef}
              id={props.resultId}
              type="button"
              role="option"
              // aria-activedescendant options: focus stays on the search input,
              // which owns all keyboard interaction for the listbox.
              tabIndex={-1}
              aria-selected={props.isHighlighted}
              aria-current={accessibility.current}
              aria-label={accessibility.label}
              onMouseMove={props.onHighlight}
              onClick={props.onSelect}
              className={cn(
                "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
                props.isHighlighted || props.isRouteActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
                isFileDragOver && "ring-1 ring-inset ring-primary/70",
                isFileDragOver && !props.isRouteActive && "bg-sidebar-row-hover",
              )}
            />
          }
        >
          {props.project ? (
            <ProjectFavicon project={props.project} className="size-4 shrink-0" />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2.5">
              <span className="min-w-0 flex-1 truncate">{thread.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground/55 tabular-nums">
                {threadTimeLabel(thread)}
              </span>
            </span>
            {props.searchMatch ? (
              <ThreadSearchMatchExcerpt
                match={{
                  source: props.searchMatch.source,
                  snippet: props.searchMatch.snippet,
                  query: props.searchQuery,
                }}
              />
            ) : null}
          </span>
        </TooltipTrigger>
        <SidebarThreadTooltip
          thread={thread}
          project={props.project}
          projectDisplayName={props.projectDisplayName}
          environmentLabel={props.environmentLabel}
          environmentMachine={props.environmentMachine}
          providerEntry={providerEntry}
          showInstanceBadge={showInstanceBadge}
          modelInstanceId={modelInstanceId}
          modelLabel={modelLabel}
          branchMismatch={branchMismatch}
          terminalStatus={terminalStatus}
          terminalProcessCount={runningTerminalIds.length}
        />
      </Tooltip>
    </li>
  );
});

export function SidebarSearchResults(props: {
  results: readonly SidebarThreadSummary[];
  isPending: boolean;
  projectByKey: ReadonlyMap<string, EnvironmentProject>;
  projectDisplayNameByKey: ReadonlyMap<string, string>;
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  environmentMachineById: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  providerEntriesByEnvironment: ReadonlyMap<string, ReadonlyMap<string, ProviderInstanceEntry>>;
  routeThreadKey: string | null;
  searchMatchByKey: ReadonlyMap<string, EnvironmentThreadSearchMatch>;
  searchQuery: string;
  activeIndex: number;
  onHighlight: (index: number) => void;
  onSelect: (thread: SidebarThreadSummary) => void;
  onFileDropThreads: (threadRef: ScopedThreadRef, files: File[]) => void;
}) {
  const t = useT();
  const {
    results: threadSearchResults,
    isPending,
    projectByKey,
    projectDisplayNameByKey,
    environmentLabelById,
    environmentMachineById,
    providerEntriesByEnvironment,
    routeThreadKey,
    searchMatchByKey: threadSearchMatchByKey,
    searchQuery: threadSearchQuery,
    activeIndex: activeSearchResultIndex,
    onHighlight: setActiveSearchResultIndex,
    onSelect: selectThreadSearchResult,
    onFileDropThreads: handleThreadFileDrop,
  } = props;
  return threadSearchResults.length > 0 ? (
    <TooltipProvider
      key="sidebar-thread-search-tooltips-150"
      delay={150}
      closeDelay={0}
      timeout={400}
    >
      <ul
        id="sidebar-thread-search-results"
        role="listbox"
        aria-label={t("Thread search results")}
        className="flex flex-col gap-px"
      >
        {threadSearchResults.map((thread, index) => {
          const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
          return (
            <SidebarSearchResultRow
              key={threadKey}
              thread={thread}
              project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
              projectDisplayName={
                projectDisplayNameByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null
              }
              environmentLabel={environmentLabelById.get(thread.environmentId) ?? null}
              environmentMachine={environmentMachineById.get(thread.environmentId) ?? "server"}
              providerEntryByInstanceId={
                providerEntriesByEnvironment.get(thread.environmentId) ?? EMPTY_PROVIDER_ENTRIES
              }
              isHighlighted={activeSearchResultIndex === index}
              isRouteActive={routeThreadKey === threadKey}
              resultId={`sidebar-thread-search-result-${index}`}
              searchMatch={
                threadSearchMatchByKey.get(
                  threadSearchMatchKey({
                    environmentId: thread.environmentId,
                    threadId: thread.id,
                  }),
                ) ?? null
              }
              searchQuery={threadSearchQuery}
              onHighlight={() => setActiveSearchResultIndex(index)}
              onSelect={() => selectThreadSearchResult(thread)}
              onFileDropThreads={handleThreadFileDrop}
            />
          );
        })}
      </ul>
    </TooltipProvider>
  ) : (
    <p role="status" className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">
      {isPending ? t("Searching thread messages…") : t("No threads found")}
    </p>
  );
}
