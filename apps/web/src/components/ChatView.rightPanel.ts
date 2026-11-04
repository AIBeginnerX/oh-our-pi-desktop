import {
  type ModelSelection,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { getTerminalLabel, nextTerminalId } from "@t3tools/shared/terminalLabels";
import { useCallback, useEffect, useRef } from "react";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { readLocalApi } from "../localApi";
import { useDiffPanelStore } from "../diffPanelStore";
import { MAX_TERMINALS_PER_GROUP } from "../types";
import {
  pullRequestSurface,
  selectActiveRightPanelSurface,
  type RightPanelSurface,
  useRightPanelStore,
} from "../rightPanelStore";
import { isPreviewSupportedInRuntime, setActivePreviewTab } from "../previewStateStore";
import { closePreviewSession } from "./preview/closePreviewSession";
import { subscribePreviewAction } from "./preview/previewActionBus";
import { browserMiniPlayerSource, usePreviewMiniPlayerStore } from "../previewMiniPlayerStore";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { confirmTerminalClose } from "../lib/terminalCloseConfirm";
import {
  agentControlledBrowserCloseConfirmation,
  shouldOpenProactivePullRequest,
  shouldRetargetThreadPullRequestPanel,
  shouldOpenProactiveTurnDiff,
  observeProactivePanelUserChoice,
  resolveProactiveTurnDiffAction,
  resolveThreadMetadataUpdateForNextTurn,
} from "./ChatView.logic";
import type { useChatViewThreadState } from "./ChatView.threadState";
import type { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import type { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";

export function useChatViewRightPanel({
  threadState,
  projectEnvironment,
  terminalsAndScripts,
}: {
  threadState: ReturnType<typeof useChatViewThreadState>;
  projectEnvironment: ReturnType<typeof useChatViewProjectAndEnvironment>;
  terminalsAndScripts: ReturnType<typeof useChatViewTerminalsAndScripts>;
}) {
  const {
    isServerThread,
    activeThreadKey,
    activeThreadRef,
    settings,
    shouldUseRightPanelSheet,
    threadDetailLoading,
    activeThread,
    onDiffPanelOpen,
    activeRightPanelSurface,
    setMaximizedRightPanelThreadKey,
    previewPanelOpen,
    activePreviewState,
    activeThreadId,
    allocatableActiveTerminalIds,
    setTerminalFocusRequestId,
    openTerminal,
    closeTerminalMutation,
    storeCloseTerminal,
    activeTerminalLabelsById,
    runningTerminalIds,
    diffOpen,
    rightPanelOpen,
    canMaximizeRightPanel,
    routeThreadKey,
    closePreview,
    rightPanelState,
    serverThread,
    updateThreadMetadata,
    environmentId,
    setThreadRuntimeMode,
    setThreadInteractionMode,
  } = threadState;
  const {
    activeRunningTurnId,
    clientSettingsHydrated,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    latestTurnSettled,
    activeLatestTurn,
    activeProject,
  } = projectEnvironment;
  const {
    observedThreadPullRequestRef,
    linkedThreadPullRequest,
    proactivePullRequestsKey,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    hasLinkedPullRequestDetail,
    gitStatusQuery,
    createBrowserSurface,
    gitCwd,
    activeThreadWorktreePath,
    closeTerminal,
  } = terminalsAndScripts;

  const proactivePanelObservationRef = useRef<ReturnType<
    typeof observeProactivePanelUserChoice
  > | null>(null);

  useEffect(() => {
    if (!isServerThread || activeThreadKey === null || activeThreadRef === null) {
      proactivePanelObservationRef.current = null;
      observedThreadPullRequestRef.current = null;
      return;
    }
    const panels = useRightPanelStore.getState();
    const observation = observeProactivePanelUserChoice(proactivePanelObservationRef.current, {
      threadKey: activeThreadKey,
      runningTurnId: activeRunningTurnId,
      userActionRevision: panels.getUserActionRevision(activeThreadRef),
    });
    proactivePanelObservationRef.current = observation;
    const {
      runningTurnId: previousRunningTurnId,
      targetKey: previousTargetKey,
      userActionRevision,
    } = observation;
    const openSurface = selectActiveRightPanelSurface(panels.byThreadKey, activeThreadRef);
    const previousPullRequest = observedThreadPullRequestRef.current;
    observedThreadPullRequestRef.current = {
      threadKey: activeThreadKey,
      reference: linkedThreadPullRequest,
    };
    const followSelectedPullRequest =
      previousPullRequest?.threadKey === activeThreadKey &&
      shouldRetargetThreadPullRequestPanel(
        previousPullRequest.reference,
        linkedThreadPullRequest,
        openSurface,
      );
    // Following the selected linked PR does not open an unrelated panel, so it
    // remains available with proactive panels off. It still respects a later choice.
    if (followSelectedPullRequest && linkedThreadPullRequest !== null) {
      panels.openProactive(
        activeThreadRef,
        pullRequestSurface(linkedThreadPullRequest),
        userActionRevision,
      );
    }
    if (!clientSettingsHydrated) return;

    const proactivePanelsEnabled = settings.proactivePanelsEnabled && !shouldUseRightPanelSheet;
    const eligibleLink =
      proactivePanelsEnabled &&
      shouldOpenProactivePullRequest(previousTargetKey, proactivePullRequestsKey);
    const shouldDeferLink = eligibleLink && !pullRequestsCapabilityKnown;
    proactivePanelObservationRef.current = {
      ...observation,
      targetKey: shouldDeferLink ? (previousTargetKey ?? null) : proactivePullRequestsKey,
    };
    if (eligibleLink && pullRequestsCapabilityKnown) {
      if (
        pullRequestsSurfaceAvailable &&
        (visiblePullRequestCount > 1 || !hasLinkedPullRequestDetail || !supportsPullRequests)
      ) {
        panels.openProactive(
          activeThreadRef,
          { id: "pull-requests", kind: "pull-requests" },
          userActionRevision,
        );
      } else if (
        !followSelectedPullRequest &&
        supportsPullRequests &&
        linkedThreadPullRequest !== null
      ) {
        panels.openProactive(
          activeThreadRef,
          pullRequestSurface(linkedThreadPullRequest),
          userActionRevision,
        );
      }
    }
    if (threadDetailLoading) return;

    const settledTurnId = latestTurnSettled ? (activeLatestTurn?.turnId ?? null) : null;
    const newlyCompletedTurnId = shouldOpenProactiveTurnDiff({
      previousRunningTurnId,
      runningTurnId: activeRunningTurnId,
      settledTurnId,
      turnCompleted: activeLatestTurn?.state === "completed",
    })
      ? settledTurnId
      : null;
    const eligibleCompletion =
      proactivePanelsEnabled &&
      newlyCompletedTurnId !== null &&
      !(
        proactivePullRequestsKey !== null &&
        (!pullRequestsCapabilityKnown || supportsPullRequests || pullRequestsSurfaceAvailable)
      );
    const completedCheckpoint = eligibleCompletion
      ? activeThread?.checkpoints.find((checkpoint) => checkpoint.turnId === newlyCompletedTurnId)
      : undefined;
    const diffAction = eligibleCompletion
      ? resolveProactiveTurnDiffAction({
          checkpoint: completedCheckpoint,
          isGitRepo: gitStatusQuery.data?.isRepo,
        })
      : "ignore";
    proactivePanelObservationRef.current = {
      ...proactivePanelObservationRef.current,
      // Preserve first-entry eligibility while capabilities, checkpoint or repository load.
      runningTurnId:
        diffAction === "defer" || shouldDeferLink ? previousRunningTurnId : activeRunningTurnId,
    };
    if (diffAction !== "open" || newlyCompletedTurnId === null) return;
    if (!panels.openProactive(activeThreadRef, { id: "diff", kind: "diff" }, userActionRevision)) {
      return;
    }
    useDiffPanelStore.getState().selectGitScope(activeThreadRef, "unstaged");
    onDiffPanelOpen?.();
  }, [
    activeThread?.checkpoints,
    activeLatestTurn?.turnId,
    activeLatestTurn?.state,
    activeRunningTurnId,
    activeThreadKey,
    activeThreadRef,
    clientSettingsHydrated,
    gitStatusQuery.data?.isRepo,
    isServerThread,
    latestTurnSettled,
    linkedThreadPullRequest,
    proactivePullRequestsKey,
    hasLinkedPullRequestDetail,
    onDiffPanelOpen,
    pullRequestsCapabilityKnown,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    settings.proactivePanelsEnabled,
    shouldUseRightPanelSheet,
    supportsPullRequests,
    threadDetailLoading,
  ]);
  const closePreviewPanel = useCallback(() => {
    if (activeThreadRef) {
      // Closing the panel on a live browser or device floats it instead of dropping it.
      if (activeRightPanelSurface?.kind === "preview" && activeRightPanelSurface.resourceId) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, browserMiniPlayerSource(activeRightPanelSurface.resourceId));
      } else if (activeRightPanelSurface?.kind === "device" && activeRightPanelSurface.target) {
        usePreviewMiniPlayerStore
          .getState()
          .open(activeThreadRef, { kind: "device", ...activeRightPanelSurface.target });
      }
      setMaximizedRightPanelThreadKey(null);
      useRightPanelStore.getState().close(activeThreadRef);
    }
  }, [activeRightPanelSurface, activeThreadRef]);
  const togglePreviewPanel = useCallback(() => {
    if (!activeThreadRef || !isPreviewSupportedInRuntime()) return;
    if (previewPanelOpen) {
      closePreviewPanel();
      return;
    }
    const activeTabId = activePreviewState.activeTabId;
    if (activeTabId) {
      useRightPanelStore.getState().openBrowser(activeThreadRef, activeTabId);
    } else {
      createBrowserSurface();
    }
  }, [
    activePreviewState.activeTabId,
    activeThreadRef,
    closePreviewPanel,
    createBrowserSurface,
    previewPanelOpen,
  ]);
  const addTerminalSurface = useCallback(() => {
    if (!activeThreadRef || !activeThreadId || !activeProject) return;
    const cwd = gitCwd ?? activeProject.workspaceRoot;
    const terminalId = nextTerminalId(allocatableActiveTerminalIds);
    useRightPanelStore.getState().openTerminal(activeThreadRef, terminalId);
    setTerminalFocusRequestId((value) => value + 1);
    void openTerminal({
      environmentId: activeThreadRef.environmentId,
      input: {
        threadId: activeThreadId,
        terminalId,
        cwd,
        ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
        env: projectScriptRuntimeEnv({
          project: { cwd: activeProject.workspaceRoot },
          worktreePath: activeThreadWorktreePath,
        }),
      },
    });
  }, [
    activeProject,
    activeThreadId,
    activeThreadRef,
    activeThreadWorktreePath,
    allocatableActiveTerminalIds,
    gitCwd,
    openTerminal,
  ]);
  const splitPanelTerminal = useCallback(
    (direction: "horizontal" | "vertical" = "horizontal") => {
      if (
        !activeThreadRef ||
        !activeThreadId ||
        !activeProject ||
        activeRightPanelSurface?.kind !== "terminal" ||
        activeRightPanelSurface.terminalIds.length >= MAX_TERMINALS_PER_GROUP
      ) {
        return;
      }
      const terminalId = nextTerminalId(allocatableActiveTerminalIds);
      const cwd = gitCwd ?? activeProject.workspaceRoot;
      useRightPanelStore
        .getState()
        .splitTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId, direction);
      setTerminalFocusRequestId((value) => value + 1);
      void openTerminal({
        environmentId: activeThreadRef.environmentId,
        input: {
          threadId: activeThreadId,
          terminalId,
          cwd,
          ...(activeThreadWorktreePath != null ? { worktreePath: activeThreadWorktreePath } : {}),
          env: projectScriptRuntimeEnv({
            project: { cwd: activeProject.workspaceRoot },
            worktreePath: activeThreadWorktreePath,
          }),
        },
      });
    },
    [
      activeProject,
      activeRightPanelSurface,
      activeThreadId,
      activeThreadRef,
      activeThreadWorktreePath,
      allocatableActiveTerminalIds,
      gitCwd,
      openTerminal,
    ],
  );
  const splitPanelTerminalVertical = useCallback(() => {
    splitPanelTerminal("vertical");
  }, [splitPanelTerminal]);
  const activatePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      useRightPanelStore
        .getState()
        .activateTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef],
  );
  const closePanelTerminal = useCallback(
    (terminalId: string) => {
      if (!activeThreadRef || activeRightPanelSurface?.kind !== "terminal") return;
      void closeTerminalMutation({
        environmentId: activeThreadRef.environmentId,
        input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
      });
      storeCloseTerminal(activeThreadRef, terminalId);
      useRightPanelStore
        .getState()
        .closeTerminal(activeThreadRef, activeRightPanelSurface.id, terminalId);
      setTerminalFocusRequestId((value) => value + 1);
    },
    [activeRightPanelSurface, activeThreadRef, closeTerminalMutation, storeCloseTerminal],
  );
  const requestCloseTerminal = useCallback(
    (terminalId: string) => {
      const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
      void confirmTerminalClose([label], { running: runningTerminalIds.includes(terminalId) }).then(
        (confirmed) => {
          if (confirmed) closeTerminal(terminalId);
        },
      );
    },
    [activeTerminalLabelsById, closeTerminal, runningTerminalIds],
  );
  const requestClosePanelTerminal = useCallback(
    (terminalId: string) => {
      const label = activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId);
      void confirmTerminalClose([label], { running: runningTerminalIds.includes(terminalId) }).then(
        (confirmed) => {
          if (confirmed) closePanelTerminal(terminalId);
        },
      );
    },
    [activeTerminalLabelsById, closePanelTerminal, runningTerminalIds],
  );
  const activateRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      useRightPanelStore.getState().activateSurface(activeThreadRef, surface.id);
      if (surface.kind === "preview" && surface.resourceId) {
        setActivePreviewTab(activeThreadRef, surface.resourceId);
      }
      if (surface.kind === "terminal") {
        setTerminalFocusRequestId((value) => value + 1);
      }
      if (surface.kind === "diff" && !diffOpen) {
        onDiffPanelOpen?.();
      }
    },
    [activeThreadRef, diffOpen, onDiffPanelOpen],
  );
  const toggleRightPanel = useCallback(() => {
    if (!activeThreadRef) return;
    if (rightPanelOpen) {
      closePreviewPanel();
      return;
    }
    useRightPanelStore.getState().toggleVisibility(activeThreadRef);
  }, [activeThreadRef, closePreviewPanel, rightPanelOpen]);
  const toggleRightPanelMaximized = useCallback(() => {
    if (!canMaximizeRightPanel) return;
    setMaximizedRightPanelThreadKey((threadKey) =>
      threadKey === routeThreadKey ? null : routeThreadKey,
    );
  }, [canMaximizeRightPanel, routeThreadKey]);
  const cleanupRightPanelSurfaces = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      for (const surface of surfaces) {
        if (surface.kind === "preview" && surface.resourceId) {
          void closePreviewSession({
            closePreview,
            snapshot: activePreviewState.sessions[surface.resourceId] ?? null,
            tabId: surface.resourceId,
            threadRef: activeThreadRef,
          });
        }
        if (surface.kind === "terminal") {
          for (const terminalId of surface.terminalIds) {
            storeCloseTerminal(activeThreadRef, terminalId);
            void closeTerminalMutation({
              environmentId: activeThreadRef.environmentId,
              input: { threadId: activeThreadRef.threadId, terminalId, deleteHistory: true },
            });
          }
        }
      }
    },
    [
      activeThreadRef,
      activePreviewState.sessions,
      closePreview,
      closeTerminalMutation,
      storeCloseTerminal,
    ],
  );
  const closeAfterAgentBrowserConfirmation = useCallback(
    (surfaces: readonly RightPanelSurface[], closeSurfaces: () => void) => {
      const message = agentControlledBrowserCloseConfirmation(
        surfaces,
        activePreviewState.desktopByTabId,
      );
      if (!message) {
        closeSurfaces();
        return;
      }
      const localApi = readLocalApi();
      if (!localApi) return;
      void localApi.dialogs.confirm(message, { variant: "destructive" }).then(
        (confirmed) => {
          if (confirmed) closeSurfaces();
        },
        () => undefined,
      );
    },
    [activePreviewState.desktopByTabId],
  );
  const syncActivePreviewSurface = useCallback(() => {
    if (!activeThreadRef) return;
    const nextActiveSurface = selectActiveRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      activeThreadRef,
    );
    if (nextActiveSurface?.kind === "preview" && nextActiveSurface.resourceId) {
      setActivePreviewTab(activeThreadRef, nextActiveSurface.resourceId);
    }
  }, [activeThreadRef]);
  const finishRightPanelSurfaceClose = useCallback(
    (surfaces: readonly RightPanelSurface[]) => {
      if (!activeThreadRef) return;
      cleanupRightPanelSurfaces(surfaces);
      const store = useRightPanelStore.getState();
      for (const surface of surfaces) {
        store.closeSurface(activeThreadRef, surface.id);
      }
      syncActivePreviewSurface();
    },
    [activeThreadRef, cleanupRightPanelSurfaces, syncActivePreviewSurface],
  );
  const closeRightPanelSurface = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const finishClose = () => finishRightPanelSurfaceClose([surface]);
      if (surface.kind === "preview") {
        closeAfterAgentBrowserConfirmation([surface], finishClose);
        return;
      }
      if (surface.kind !== "terminal") {
        finishClose();
        return;
      }
      const activeLabel =
        activeTerminalLabelsById.get(surface.activeTerminalId) ??
        getTerminalLabel(surface.activeTerminalId);
      const otherLabels = surface.terminalIds
        .filter((terminalId) => terminalId !== surface.activeTerminalId)
        .map(
          (terminalId) => activeTerminalLabelsById.get(terminalId) ?? getTerminalLabel(terminalId),
        );
      const running = surface.terminalIds.some((terminalId) =>
        runningTerminalIds.includes(terminalId),
      );
      void confirmTerminalClose([activeLabel, ...otherLabels], { running }).then((confirmed) => {
        if (confirmed) finishClose();
      });
    },
    [
      activeThreadRef,
      activeTerminalLabelsById,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
      runningTerminalIds,
    ],
  );
  const closeOtherRightPanelSurfaces = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaces = rightPanelState.surfaces.filter((entry) => entry.id !== surface.id);
      const finishClose = () => finishRightPanelSurfaceClose(surfaces);
      closeAfterAgentBrowserConfirmation(surfaces, finishClose);
    },
    [
      activeThreadRef,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
      rightPanelState.surfaces,
    ],
  );
  const closeRightPanelSurfacesToRight = useCallback(
    (surface: RightPanelSurface) => {
      if (!activeThreadRef) return;
      const surfaceIndex = rightPanelState.surfaces.findIndex((entry) => entry.id === surface.id);
      if (surfaceIndex < 0) return;
      const surfaces = rightPanelState.surfaces.slice(surfaceIndex + 1);
      const finishClose = () => finishRightPanelSurfaceClose(surfaces);
      closeAfterAgentBrowserConfirmation(surfaces, finishClose);
    },
    [
      activeThreadRef,
      closeAfterAgentBrowserConfirmation,
      finishRightPanelSurfaceClose,
      rightPanelState.surfaces,
    ],
  );
  const closeAllRightPanelSurfaces = useCallback(() => {
    if (!activeThreadRef) return;
    const finishClose = () => finishRightPanelSurfaceClose(rightPanelState.surfaces);
    closeAfterAgentBrowserConfirmation(rightPanelState.surfaces, finishClose);
  }, [
    activeThreadRef,
    closeAfterAgentBrowserConfirmation,
    finishRightPanelSurfaceClose,
    rightPanelState.surfaces,
  ]);
  const copyRightPanelFilePath = useCallback((relativePath: string) => {
    if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: "Clipboard API unavailable.",
        }),
      );
      return;
    }

    void navigator.clipboard.writeText(relativePath).then(
      () => {
        toastManager.add({
          type: "success",
          title: "Path copied",
          description: relativePath,
        });
      },
      (error) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to copy path",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      },
    );
  }, []);
  useEffect(
    () =>
      subscribePreviewAction((action) => {
        if (action === "toggle-panel") togglePreviewPanel();
      }),
    [togglePreviewPanel],
  );
  const persistThreadSettingsForNextTurn = useCallback(
    async (input: {
      threadId: ThreadId;
      createdAt: string;
      modelSelection?: ModelSelection;
      branch?: string;
      runtimeMode: RuntimeMode;
      interactionMode: ProviderInteractionMode;
    }): Promise<AtomCommandResult<void, unknown>> => {
      if (!serverThread) {
        return AsyncResult.success(undefined);
      }

      let result: AtomCommandResult<void, unknown> = AsyncResult.success(undefined);
      const metadataUpdate = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: serverThread.modelSelection,
        ...(input.modelSelection ? { nextModelSelection: input.modelSelection } : {}),
        currentBranch: serverThread.branch,
        ...(input.branch ? { nextBranch: input.branch } : {}),
      });
      if (metadataUpdate) {
        result = mapAtomCommandResult(
          await updateThreadMetadata({
            environmentId,
            input: {
              threadId: input.threadId,
              ...metadataUpdate,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.runtimeMode !== serverThread.runtimeMode) {
        result = mapAtomCommandResult(
          await setThreadRuntimeMode({
            environmentId,
            input: {
              threadId: input.threadId,
              runtimeMode: input.runtimeMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
        if (result._tag === "Failure") {
          return result;
        }
      }

      if (input.interactionMode !== serverThread.interactionMode) {
        result = mapAtomCommandResult(
          await setThreadInteractionMode({
            environmentId,
            input: {
              threadId: input.threadId,
              interactionMode: input.interactionMode,
              createdAt: input.createdAt,
            },
          }),
          () => undefined,
        );
      }
      return result;
    },
    [
      environmentId,
      serverThread,
      setThreadInteractionMode,
      setThreadRuntimeMode,
      updateThreadMetadata,
    ],
  );

  return {
    toggleRightPanel,
    toggleRightPanelMaximized,
    closeRightPanelSurface,
    splitPanelTerminal,
    requestClosePanelTerminal,
    requestCloseTerminal,
    addTerminalSurface,
    persistThreadSettingsForNextTurn,
    splitPanelTerminalVertical,
    activatePanelTerminal,
    closePanelTerminal,
    activateRightPanelSurface,
    closeOtherRightPanelSurfaces,
    closeRightPanelSurfacesToRight,
    closeAllRightPanelSurfaces,
    copyRightPanelFilePath,
    closePreviewPanel,
  };
}
