import { type EnvironmentId, resolveEnvironmentMachineKind } from "@t3tools/contracts";
import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isLatestTurnSettled } from "../session-logic";
import { DEFAULT_INTERACTION_MODE } from "../types";
import { useRightPanelStore } from "../rightPanelStore";
import { getConfiguredPreviewUrls } from "./preview/previewEmptyStateLogic";
import { DownloadIcon } from "lucide-react";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { newDraftId, newThreadId } from "~/lib/utils";
import { useBrowserHistoryStore } from "~/browserHistoryStore";
import { registerFaviconProjectForThread } from "~/browserFaviconStore";
import { normalizeProviderAccentColor } from "../providerInstances";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { useRemoveClonedProject } from "../hooks/useRemoveClonedProject";
import {
  derivePhysicalProjectKey,
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { buildDraftThreadRouteParams } from "../threadRoutes";
import { type DraftThreadEnvMode } from "../composerDraftStore";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { useEnvironmentDisconnectDelay } from "../hooks/useEnvironmentDisconnectDelay";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { sourceControlEnvironment } from "../state/sourceControl";
import { useProjectClone } from "../state/projectClones";
import { projectCloneDisplayName, projectCloneProgressSummary } from "@t3tools/contracts";
import { useProject, useProjects } from "../state/entities";
import { environmentShell } from "../state/shell";
import { type EnvironmentOption, shouldShowEnvironmentIndicator } from "./BranchToolbar.logic";
import type { ComposerBannerStackItem } from "./chat/ComposerBannerStack";
import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  hasEnvironmentReconnectWarningGraceElapsed,
  scheduleEnvironmentReconnectWarning,
  deriveLockedProvider,
  reconcileMountedTerminalThreadIds,
  startNewThreadForProject,
} from "./ChatView.logic";
import { clampFileAttachmentUploadBytes } from "@t3tools/client-runtime/state/attachments";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { useAutoBalanceUpdateBanner } from "./chat/useAutoBalanceUpdateBanner";
import {
  buildVersionMismatchDismissalKey,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "../versionSkew";
import {
  EMPTY_PROVIDERS,
  EMPTY_PENDING_FILE_SURFACE_IDS,
  EnvironmentUnavailableState,
} from "./ChatView.helpers";
import type { useChatViewThreadState } from "./ChatView.threadState";

export function useChatViewProjectAndEnvironment({
  threadState,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
}) {
  const {
    activeThread,
    serverThread,
    markThreadVisited,
    setMountedTerminalThreadKeys,
    existingOpenTerminalThreadKeys,
    activeThreadKey,
    activeTerminalDrawerPresence,
    settings,
    handleNewThread,
    isServerThread,
    navigate,
    activeThreadRef,
    primaryEnvironment,
    environmentById,
    retryEnvironment,
    setEnvironmentEnabled,
    canCheckoutPullRequestIntoThread,
    setPullRequestDialogState,
    getDraftSessionByLogicalProjectKey,
    setDraftThreadContext,
    setLogicalProjectDraftThreadId,
    routeKind,
    draftId,
    getDraftSession,
    composerActiveProvider,
    environmentId,
    draftThread,
    composerHasAttachments,
    environments,
  } = threadState;

  const activeLatestTurn = activeThread?.latestTurn ?? null;
  const activeRunningTurnId =
    (activeThread?.session?.status === "running" ? activeThread.session.activeTurnId : null) ??
    (activeLatestTurn?.state === "running" ? activeLatestTurn.turnId : null);
  // Reading a finished thread clears the sidebar's Done badge. The visit is
  // stamped at the turn's completion time — not now/updatedAt — so it clears
  // exactly the completion the user is looking at: a wake or completion that
  // lands later still gets its signal (markThreadVisited never moves the
  // timestamp backwards).
  useEffect(() => {
    const completedAt = serverThread?.latestTurn?.completedAt;
    if (!serverThread?.id || !completedAt) return;
    markThreadVisited(
      scopedThreadKey(scopeThreadRef(serverThread.environmentId, serverThread.id)),
      completedAt,
    );
  }, [
    markThreadVisited,
    serverThread?.environmentId,
    serverThread?.id,
    serverThread?.latestTurn?.completedAt,
  ]);
  useEffect(() => {
    setMountedTerminalThreadKeys((currentThreadIds) => {
      const nextThreadIds = reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: existingOpenTerminalThreadKeys,
        activeThreadId: activeThreadKey,
        activeThreadTerminalOpen: activeTerminalDrawerPresence.present,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
      });
      return currentThreadIds.length === nextThreadIds.length &&
        currentThreadIds.every((nextThreadId, index) => nextThreadId === nextThreadIds[index])
        ? currentThreadIds
        : nextThreadIds;
    });
  }, [activeTerminalDrawerPresence.present, activeThreadKey, existingOpenTerminalThreadKeys]);
  const latestTurnSettled = isLatestTurnSettled(activeLatestTurn, activeThread?.session ?? null);
  const activeProjectRef = useMemo(
    () =>
      activeThread ? scopeProjectRef(activeThread.environmentId, activeThread.projectId) : null,
    [activeThread?.environmentId, activeThread?.projectId],
  );
  const activeProject = useProject(activeProjectRef);
  // Environment settings with the active project's overrides applied.
  const activeProjectSettings = useMemo(
    () => resolveProjectSettings(settings, activeProject?.id ?? null, activeProject ?? undefined),
    [activeProject, settings],
  );
  const activeProjectScripts = useMemo(
    () => (activeProject ? resolveProjectScripts(settings, activeProject) : []),
    [activeProject, settings],
  );
  // A project added by cloning exists before its files do. The draft stays
  // editable throughout; only sending waits for the clone, and a failed
  // clone offers its retry right where the user is looking.
  const activeProjectClone = useProjectClone(activeProjectRef);
  const cancelProjectClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryProjectClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const removeClonedProject = useRemoveClonedProject();
  // The banner mirrors the server's clone state, so a request that never got
  // there needs its own feedback.
  const runProjectCloneAction = useCallback(
    async (
      title: string,
      action: () => Promise<AtomCommandResult<unknown, unknown>>,
    ): Promise<void> => {
      const result = await action();
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      }
    },
    [],
  );
  const projectCloneSendBlockReason =
    activeProjectClone === null
      ? null
      : activeProjectClone.phase === "running"
        ? "Cloning repository"
        : activeProjectClone.phase === "done"
          ? null
          : "Repository not cloned";
  const projectCloneBannerItem = useMemo<ComposerBannerStackItem | null>(() => {
    if (!activeProjectClone || !activeProjectRef || activeProjectClone.phase === "done") {
      return null;
    }
    const name = projectCloneDisplayName(activeProjectClone);
    const { environmentId, projectId } = activeProjectRef;
    if (activeProjectClone.phase === "running") {
      return {
        id: `project-clone:${projectId}`,
        variant: "info",
        compact: true,
        priority: "activity",
        icon: <DownloadIcon />,
        title: `Cloning ${name}`,
        description: projectCloneProgressSummary(activeProjectClone),
        actions: (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneAction("Failed to cancel clone", () =>
                cancelProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Cancel
          </Button>
        ),
      };
    }
    const cancelled = activeProjectClone.phase === "cancelled";
    return {
      id: `project-clone:${projectId}`,
      variant: cancelled ? "warning" : "error",
      compact: true,
      icon: <DownloadIcon />,
      title: cancelled ? `Cancelled cloning ${name}` : `Failed to clone ${name}`,
      description: cancelled ? "Retry to bring in the repository." : activeProjectClone.error,
      actions: (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => void removeClonedProject({ environmentId, projectId })}
          >
            Remove project
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void runProjectCloneAction("Failed to retry clone", () =>
                retryProjectClone({ environmentId, input: { projectId } }),
              )
            }
          >
            Retry
          </Button>
        </>
      ),
    };
  }, [
    activeProjectClone,
    activeProjectRef,
    cancelProjectClone,
    removeClonedProject,
    retryProjectClone,
    runProjectCloneAction,
  ]);
  const activeProjectDefaultModelSelection = activeProjectSettings.settings.defaultModelSelection;
  const handleNewThreadInActiveProject = useCallback(() => {
    startNewThreadForProject(activeProjectRef, handleNewThread);
  }, [activeProjectRef, handleNewThread]);
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const activeDraftLogicalProjectKey =
    !isServerThread && activeProject
      ? deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings)
      : undefined;
  const handleOpenDraftProjectSettings = useCallback(() => {
    if (!activeDraftLogicalProjectKey) return;
    void navigate({
      to: "/projects/$projectKey",
      params: { projectKey: activeDraftLogicalProjectKey },
    });
  }, [activeDraftLogicalProjectKey, navigate]);
  const activeEnvironmentShell = useEnvironmentQuery(
    activeThread ? environmentShell.stateAtom(activeThread.environmentId) : null,
  );
  const activeEnvironmentBootstrapComplete = activeEnvironmentShell.data?.snapshot._tag === "Some";
  const activeProjectKey = activeProject
    ? `${activeProject.environmentId}:${activeProject.workspaceRoot}`
    : null;
  const clientSettingsHydrated = useClientSettingsHydrated();
  const [pendingFileSurfaceIdsByProject, setPendingFileSurfaceIdsByProject] = useState<
    ReadonlyMap<string, ReadonlySet<string>>
  >(() => new Map());
  const pendingFileSurfaceIds = activeProjectKey
    ? (pendingFileSurfaceIdsByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS)
    : EMPTY_PENDING_FILE_SURFACE_IDS;
  const handleFilePendingChange = useCallback(
    (relativePath: string, pending: boolean) => {
      if (!activeProjectKey) return;
      setPendingFileSurfaceIdsByProject((currentByProject) => {
        const current = currentByProject.get(activeProjectKey) ?? EMPTY_PENDING_FILE_SURFACE_IDS;
        const surfaceId = `file:${relativePath}`;
        if (current.has(surfaceId) === pending) return currentByProject;
        const next = new Set(current);
        if (pending) next.add(surfaceId);
        else next.delete(surfaceId);
        const nextByProject = new Map(currentByProject);
        if (next.size === 0) nextByProject.delete(activeProjectKey);
        else nextByProject.set(activeProjectKey, next);
        return nextByProject;
      });
    },
    [activeProjectKey],
  );
  const configuredPreviewUrls = useMemo(
    () => getConfiguredPreviewUrls(activeProjectScripts),
    [activeProjectScripts],
  );

  useEffect(() => {
    if (!activeThreadRef || !activeEnvironmentBootstrapComplete) return;
    useRightPanelStore.getState().reconcileFileSurfaces(activeThreadRef, activeProject !== null);
  }, [activeEnvironmentBootstrapComplete, activeProject, activeThreadRef]);

  // Compute the list of environments this logical project spans, used to
  // drive the environment picker in BranchToolbar.
  const allProjects = useProjects();
  const primaryEnvironmentId = primaryEnvironment?.environmentId ?? null;
  useEffect(() => {
    if (!activeThreadRef || !activeProjectRef) return;
    registerFaviconProjectForThread(activeThreadRef, activeProjectRef);
  }, [activeProjectRef, activeThreadRef]);
  useEffect(() => {
    if (!clientSettingsHydrated || !activeThreadRef || !activeProject) return;
    // Reuse the sidebar's grouping so history follows the project rows the user
    // sees. Deriving the key from the active project alone would miss the
    // identity a duplicate row borrows from its siblings.
    const logicalKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects: allProjects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
    });
    useBrowserHistoryStore
      .getState()
      .registerThreadProject(
        activeThreadRef,
        logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(activeProject)) ??
          deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings),
      );
  }, [
    activeProject,
    activeThreadRef,
    allProjects,
    clientSettingsHydrated,
    primaryEnvironmentId,
    projectGroupingSettings,
  ]);
  const activeEnvironment =
    activeThread == null ? null : (environmentById.get(activeThread.environmentId) ?? null);
  const activeEnvironmentConnectionPhase = activeEnvironment?.connection.phase ?? "available";
  const activeEnvironmentUnavailable =
    activeEnvironment !== null && activeEnvironmentConnectionPhase !== "connected";
  const activeReconnectingEnvironmentId =
    activeEnvironmentConnectionPhase === "connecting" ||
    activeEnvironmentConnectionPhase === "reconnecting"
      ? (activeEnvironment?.environmentId ?? null)
      : null;
  const [reconnectWarningGraceElapsedEnvironmentId, setReconnectWarningGraceElapsedEnvironmentId] =
    useState<EnvironmentId | null>(null);
  const reconnectWarningGraceElapsed = hasEnvironmentReconnectWarningGraceElapsed(
    activeReconnectingEnvironmentId,
    reconnectWarningGraceElapsedEnvironmentId,
  );
  useEffect(() => {
    setReconnectWarningGraceElapsedEnvironmentId(null);
    if (activeReconnectingEnvironmentId === null) return;
    return scheduleEnvironmentReconnectWarning(() =>
      setReconnectWarningGraceElapsedEnvironmentId(activeReconnectingEnvironmentId),
    );
  }, [activeReconnectingEnvironmentId]);
  const activeEnvironmentUnavailableLabel = activeEnvironment?.label ?? null;
  const activeEnvironmentUnavailableState = useMemo<EnvironmentUnavailableState | null>(() => {
    if (!activeEnvironmentUnavailable || !activeEnvironmentUnavailableLabel || !activeEnvironment) {
      return null;
    }

    return {
      environmentId: activeEnvironment.environmentId,
      label: activeEnvironmentUnavailableLabel,
      connection: activeEnvironment.connection,
    };
  }, [activeEnvironment, activeEnvironmentUnavailable, activeEnvironmentUnavailableLabel]);
  const handleReconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      const result = await retryEnvironment(environmentId);
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not reconnect environment",
            description: error instanceof Error ? error.message : "Failed to reconnect.",
          }),
        );
      }
    },
    [retryEnvironment],
  );
  const disconnectDelayElapsed = useEnvironmentDisconnectDelay(
    activeEnvironmentUnavailable ? activeEnvironment.environmentId : null,
  );
  const canDisconnectActiveEnvironment =
    disconnectDelayElapsed &&
    activeEnvironment !== null &&
    activeEnvironment.entry.target._tag !== "PrimaryConnectionTarget" &&
    !isDesktopLocalConnectionTarget(activeEnvironment.entry.target);
  const [disconnectingEnvironment, setDisconnectingEnvironment] = useState(false);
  const handleDisconnectActiveEnvironment = useCallback(
    async (environmentId: EnvironmentId) => {
      setDisconnectingEnvironment(true);
      const result = await setEnvironmentEnabled({ environmentId, enabled: false });
      setDisconnectingEnvironment(false);
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not disconnect server",
              description: error instanceof Error ? error.message : "Failed to disconnect.",
            }),
          );
        }
        return;
      }
      void navigate({ to: "/", replace: true });
    },
    [navigate, setEnvironmentEnabled],
  );
  const logicalProjectEnvironments = useMemo(() => {
    if (!activeProject) return [];
    const logicalKey = deriveLogicalProjectKeyFromSettings(activeProject, projectGroupingSettings);
    const memberProjects = allProjects.filter(
      (p) => deriveLogicalProjectKeyFromSettings(p, projectGroupingSettings) === logicalKey,
    );
    const seen = new Set<string>();
    const envs: EnvironmentOption[] = [];
    for (const p of memberProjects) {
      if (seen.has(p.environmentId)) continue;
      seen.add(p.environmentId);
      const isPrimary = p.environmentId === primaryEnvironmentId;
      const environment = environmentById.get(p.environmentId) ?? null;
      envs.push({
        environmentId: p.environmentId,
        projectId: p.id,
        label: environment?.label ?? p.environmentId,
        isPrimary,
        machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
      });
    }
    // Sort: primary first, then alphabetical
    envs.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    return envs;
  }, [activeProject, allProjects, projectGroupingSettings, primaryEnvironmentId, environmentById]);
  const hasMultipleEnvironments = logicalProjectEnvironments.length > 1;
  const activeEnvironmentOption =
    logicalProjectEnvironments.find(
      (environment) => environment.environmentId === activeThread?.environmentId,
    ) ?? null;
  const showComposerEnvironmentIndicator = shouldShowEnvironmentIndicator({
    activeEnvironment: activeEnvironmentOption,
    canPickEnvironment: hasMultipleEnvironments,
  });

  const openPullRequestDialog = useCallback(
    (reference?: string) => {
      if (!canCheckoutPullRequestIntoThread) {
        return;
      }
      setPullRequestDialogState({
        initialReference: reference ?? null,
        key: Date.now(),
      });
    },
    [canCheckoutPullRequestIntoThread],
  );

  const closePullRequestDialog = useCallback(() => {
    setPullRequestDialogState(null);
  }, []);

  const openOrReuseProjectDraftThread = useCallback(
    async (input: { branch: string; worktreePath: string | null; envMode: DraftThreadEnvMode }) => {
      if (!activeProject) {
        throw new Error("No active project is available for this pull request.");
      }
      const activeProjectRef = scopeProjectRef(activeProject.environmentId, activeProject.id);
      const logicalProjectKey = deriveLogicalProjectKeyFromSettings(
        activeProject,
        projectGroupingSettings,
      );
      const storedDraftSession = getDraftSessionByLogicalProjectKey(logicalProjectKey);
      if (storedDraftSession) {
        setDraftThreadContext(storedDraftSession.draftId, input);
        setLogicalProjectDraftThreadId(
          logicalProjectKey,
          activeProjectRef,
          storedDraftSession.draftId,
          {
            threadId: storedDraftSession.threadId,
            ...input,
          },
        );
        if (routeKind !== "draft" || draftId !== storedDraftSession.draftId) {
          await navigate({
            to: "/draft/$draftId",
            params: buildDraftThreadRouteParams(storedDraftSession.draftId),
          });
        }
        return storedDraftSession.threadId;
      }

      const activeDraftSession = routeKind === "draft" && draftId ? getDraftSession(draftId) : null;
      if (
        !isServerThread &&
        activeDraftSession?.logicalProjectKey === logicalProjectKey &&
        draftId
      ) {
        setDraftThreadContext(draftId, input);
        setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, draftId, {
          threadId: activeDraftSession.threadId,
          createdAt: activeDraftSession.createdAt,
          runtimeMode: activeDraftSession.runtimeMode,
          interactionMode: activeDraftSession.interactionMode,
          ...input,
        });
        return activeDraftSession.threadId;
      }

      const nextDraftId = newDraftId();
      const nextThreadId = newThreadId();
      setLogicalProjectDraftThreadId(logicalProjectKey, activeProjectRef, nextDraftId, {
        threadId: nextThreadId,
        createdAt: new Date().toISOString(),
        runtimeMode: resolveProjectSettings(settings, activeProject.id, activeProject).settings
          .defaultRuntimeMode,
        interactionMode: DEFAULT_INTERACTION_MODE,
        ...input,
      });
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(nextDraftId),
      });
      return nextThreadId;
    },
    [
      activeProject,
      draftId,
      getDraftSession,
      getDraftSessionByLogicalProjectKey,
      isServerThread,
      navigate,
      projectGroupingSettings,
      routeKind,
      settings,
      setDraftThreadContext,
      setLogicalProjectDraftThreadId,
    ],
  );

  const handlePreparedPullRequestThread = useCallback(
    async (input: { branch: string; worktreePath: string | null }) => {
      await openOrReuseProjectDraftThread({
        branch: input.branch,
        worktreePath: input.worktreePath,
        envMode: input.worktreePath ? "worktree" : "local",
      });
    },
    [openOrReuseProjectDraftThread],
  );

  // Once a thread selects an environment, never substitute the primary
  // environment's config while the selected environment is still loading.
  const serverConfig = activeThread
    ? (activeEnvironment?.serverConfig ?? null)
    : (primaryEnvironment?.serverConfig ?? null);
  const providerStatuses = serverConfig?.providers ?? EMPTY_PROVIDERS;
  const providerAccentColors = useMemo(
    () =>
      new Map(
        providerStatuses.flatMap((provider) => {
          const color = normalizeProviderAccentColor(provider.accentColor);
          return color === undefined ? [] : [[String(provider.instanceId), color] as const];
        }),
      ),
    [providerStatuses],
  );
  const selectedProviderByThreadId = composerActiveProvider ?? null;
  const threadProvider =
    activeThread?.modelSelection.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const lockedProvider = deriveLockedProvider({
    thread: activeThread,
    selectedProvider: selectedProviderByThreadId,
    threadProvider,
    providers: providerStatuses,
  });
  const pullRequestsCapabilityKnown = serverConfig !== null;
  const supportsPullRequests = serverConfig?.environment.capabilities.pullRequests === true;
  // Memory capability for the composer's project, memoized so the memoized
  // ChatComposer does not re-render on every ChatView render. `send` stays
  // false until the server advertises it, so the flow is dormant by default.
  const projectMemoryCapability = useMemo(
    () =>
      activeProject
        ? {
            projectId: activeProject.id,
            send: serverConfig?.environment.capabilities.projectMemory?.send === true,
            sendDriverKinds: serverConfig?.environment.capabilities.projectMemory?.sendDriverKinds,
          }
        : null,
    [activeProject, serverConfig],
  );
  const attachmentEnvironmentConfig = environmentById.get(environmentId)?.serverConfig ?? null;
  const attachmentUploadsCapabilityKnown = attachmentEnvironmentConfig !== null;
  const supportsQuestionAttachments =
    attachmentEnvironmentConfig?.environment.capabilities.questionAttachments === true;
  const supportsAttachmentUploads =
    attachmentEnvironmentConfig?.environment.capabilities.attachmentUploads === true;
  const advertisedFileAttachmentBytes =
    attachmentEnvironmentConfig?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const maxFileAttachmentBytes =
    advertisedFileAttachmentBytes === null
      ? null
      : clampFileAttachmentUploadBytes(advertisedFileAttachmentBytes);
  const envLocked = Boolean(
    activeThread &&
    (activeThread.messages.length > 0 ||
      (activeThread.session !== null && activeThread.session.status !== "stopped")),
  );

  const loadBalancingSettings = useClientSettings();
  const automaticEnvironment = Boolean(
    clientSettingsHydrated &&
    draftId &&
    !envLocked &&
    hasMultipleEnvironments &&
    loadBalancingSettings.loadBalancingEnabled &&
    draftThread?.environmentSelection !== "manual" &&
    (!composerHasAttachments || Boolean(draftThread?.loadBalancedEnvironmentId)) &&
    (!draftThread?.branch || draftThread.environmentSelection === "auto") &&
    !draftThread?.worktreePath,
  );
  const autoUpdateEnvironments = useMemo(
    () =>
      automaticEnvironment
        ? logicalProjectEnvironments.flatMap(({ environmentId }) => {
            const environment = environmentById.get(environmentId);
            return environment ? [environment] : [];
          })
        : [],
    [automaticEnvironment, logicalProjectEnvironments, environmentById],
  );
  const autoBalanceUpdateBanner = useAutoBalanceUpdateBanner(autoUpdateEnvironments);
  const versionMismatch = resolveServerConfigVersionMismatch(serverConfig);
  const versionMismatchDismissKey =
    versionMismatch && activeThread
      ? buildVersionMismatchDismissalKey(activeThread.environmentId, versionMismatch)
      : null;
  const [dismissedVersionMismatchKey, setDismissedVersionMismatchKey] = useState<string | null>(
    null,
  );
  const versionMismatchDismissed =
    versionMismatchDismissKey === dismissedVersionMismatchKey ||
    isVersionMismatchDismissed(versionMismatchDismissKey);
  const showVersionMismatchBanner =
    versionMismatch !== null && versionMismatchDismissKey !== null && !versionMismatchDismissed;
  const hasMultipleRegisteredEnvironments = environments.length > 1;
  const versionMismatchServerLabel =
    hasMultipleRegisteredEnvironments && activeThread
      ? `${environmentById.get(activeThread.environmentId)?.label ?? serverConfig?.environment.label ?? activeThread.environmentId} server`
      : "server";
  const serverUpdateEnvironmentId = activeThread?.environmentId ?? null;
  const versionMismatchSelfUpdate = resolveServerSelfUpdateCapability(serverConfig);
  const versionMismatchDesktopAppUpdate = supportsDesktopAppUpdate(serverConfig);
  const versionMismatchThreadContinuation = supportsServerUpdateThreadContinuation(serverConfig);
  const serverUpdateState = useAtomValue(
    serverEnvironment.updateStateAtom(serverUpdateEnvironmentId),
  );
  const [dismissedServerUpdateState, setDismissedServerUpdateState] = useState<
    typeof serverUpdateState | null
  >(null);
  const serverUpdateFailureDismissed =
    serverUpdateState === dismissedServerUpdateState ||
    isServerUpdateFailureDismissed(serverUpdateState);

  return {
    serverUpdateState,
    activeEnvironmentUnavailableState,
    canDisconnectActiveEnvironment,
    disconnectingEnvironment,
    handleDisconnectActiveEnvironment,
    reconnectWarningGraceElapsed,
    handleReconnectActiveEnvironment,
    automaticEnvironment,
    serverUpdateEnvironmentId,
    showVersionMismatchBanner,
    serverUpdateFailureDismissed,
    versionMismatchServerLabel,
    versionMismatch,
    versionMismatchSelfUpdate,
    versionMismatchDesktopAppUpdate,
    versionMismatchThreadContinuation,
    versionMismatchDismissKey,
    setDismissedServerUpdateState,
    setDismissedVersionMismatchKey,
    autoBalanceUpdateBanner,
    providerStatuses,
    selectedProviderByThreadId,
    activeProjectDefaultModelSelection,
    lockedProvider,
    supportsQuestionAttachments,
    latestTurnSettled,
    activeLatestTurn,
    serverConfig,
    activeProject,
    showComposerEnvironmentIndicator,
    logicalProjectEnvironments,
    loadBalancingSettings,
    envLocked,
    activeProjectScripts,
    supportsPullRequests,
    activeRunningTurnId,
    clientSettingsHydrated,
    pullRequestsCapabilityKnown,
    activeProjectSettings,
    activeEnvironmentUnavailable,
    projectCloneBannerItem,
    activeEnvironmentUnavailableLabel,
    supportsAttachmentUploads,
    configuredPreviewUrls,
    providerAccentColors,
    handleFilePendingChange,
    pendingFileSurfaceIds,
    handleNewThreadInActiveProject,
    activeDraftLogicalProjectKey,
    handleOpenDraftProjectSettings,
    activeProjectRef,
    attachmentUploadsCapabilityKnown,
    maxFileAttachmentBytes,
    projectCloneSendBlockReason,
    projectMemoryCapability,
    openPullRequestDialog,
    hasMultipleEnvironments,
    closePullRequestDialog,
    handlePreparedPullRequestThread,
  };
}
