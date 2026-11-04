import { isChatGptUsageLimitError } from "@t3tools/shared/usageLimits";
import { type ProjectId, type ServerProvider } from "@t3tools/contracts";
import { lazy, Suspense } from "react";
import { isElectron } from "../env";
import { useRightPanelStore } from "../rightPanelStore";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { ThreadPreviewMiniPlayer } from "./preview/ThreadPreviewMiniPlayer";
import { makeWorkspaceFileDropHandlers } from "./chat/workspaceFileDrop";
import { previewMiniPlayerSourceKey } from "../previewMiniPlayerStore";
import { pullRequestPanelContext } from "./pullRequest/pullRequestDetail.logic";
import { PullRequestDetailPanel } from "./pullRequest/PullRequestDetailPanel";
import { PullRequestDetailGhost } from "./pullRequest/PullRequestGhosts";
import { PullRequestsUnavailableState } from "./pullRequest/PullRequestsUnavailableState";
import { RightPanelTabs } from "./RightPanelTabs";
import { AgentsPanel } from "./AgentsPanel";
import { WorkflowsPanel } from "./workflows/WorkflowsPanel";
import { LinkPullRequestDialogHost } from "./pullRequest/LinkPullRequestDialog";
import { ThreadPullRequestsPanel } from "./pullRequest/ThreadPullRequestsPanel";
import { DeviceSetup } from "./device/DeviceSetup";
import { Dialog } from "./ui/dialog";
import { WizardPopup } from "./ui/wizard";
import { BranchToolbar } from "./BranchToolbar";
import { shortcutLabelForCommand } from "../keybindings";
import { ChevronDownIcon, PaperclipIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { resolveProviderSkillsForCwd } from "@t3tools/client-runtime/providerSkills";
import { ChatComposer } from "./chat/ChatComposer";
import { DraftHeroHeadline } from "./chat/DraftHeroHeadline";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import { PullRequestThreadDialog } from "./PullRequestThreadDialog";
import { MessagesTimeline } from "./chat/MessagesTimeline";
import { ChatHeader } from "./chat/ChatHeader";
import { PanelLayoutControls, RightPanelMaximizeControl } from "./chat/PanelLayoutControls";
import { expandedImageKey } from "./chat/ExpandedImagePreview";
import { NoActiveThreadState } from "./NoActiveThreadState";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { ProviderStatusBanner } from "./chat/ProviderStatusBanner";
import { dismissThreadErrorBannerForSession, ThreadErrorBanner } from "./chat/ThreadErrorBanner";
import { ComposerSurface } from "./chat/ComposerSurface";
import {
  MOBILE_COMPOSER_VIEW_TRANSITION_NAME,
  MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
} from "./chat/draftHeroTransition";
import { RightPanelSheet } from "./RightPanelSheet";
import { Button } from "./ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import {
  EMPTY_QUEUED_MESSAGES,
  EMPTY_PROVIDER_SKILLS,
  ChatViewProps,
  EMPTY_HELD_TURN_DIFF_SUMMARIES,
  noopHeldTurnDiff,
  noopHeldRevert,
  noopHeldAttachment,
} from "./ChatView.helpers";
import {
  PersistentThreadTerminalDrawer,
  PersistentThreadTerminalPanel,
} from "./ChatView.terminalDrawer";
import { useChatViewThreadState } from "./ChatView.threadState";
import { useChatViewProjectAndEnvironment } from "./ChatView.projectEnvironment";
import { useChatViewTimelineData } from "./ChatView.timelineData";
import { useChatViewTerminalsAndScripts } from "./ChatView.terminalsAndScripts";
import { useChatViewRightPanel } from "./ChatView.rightPanel";
import { useChatViewTimelineScroll } from "./ChatView.timelineScroll";
import { useChatViewThreadStatus } from "./ChatView.threadStatus";
import { useChatViewShortcutsAndRevert } from "./ChatView.shortcutsAndRevert";
import { useChatViewPendingRequests } from "./ChatView.pendingRequests";
import { useChatViewSend } from "./ChatView.send";
import { useChatViewActions } from "./ChatView.actions";

const PreviewPanel = lazy(() =>
  import("./preview/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);

const DiffPanel = lazy(() => import("./DiffPanel"));

const DevicePanel = lazy(() =>
  import("./device/DevicePanel").then((module) => ({ default: module.DevicePanel })),
);

const FilePreviewPanel = lazy(() => import("./files/FilePreviewPanel"));

export default function ChatView(props: ChatViewProps) {
  const threadState = useChatViewThreadState({ props });
  const {
    activeThread,
    terminalUiState,
    rightPanelOpen,
    activeRightPanelSurface,
    shouldUseRightPanelSheet,
    panelAnimationsActive,
    rightPanelMaximized,
    activeThreadRef,
    renderedRightPanelSurface,
    terminalFocusRequestId,
    activeThreadKey,
    composerDraftTarget,
    setIsWorkspaceFileDragActive,
    composerRef,
    rightPanelControlsAtRoot,
    reserveTitleBarControlInset,
    inlineRightPanelOwnsTitleBar,
    rightPanelControlsInPanel,
    routeKind,
    draftId,
    isServerThread,
    lastInvokedScriptByProjectId,
    isWorkspaceFileDragActive,
    visibleThreadError,
    threadErrorBannerKey,
    setThreadErrorBannerDismissTick,
    citationRequest,
    threadDetailLoading,
    citeAssistantText,
    legendListRef,
    isRevertingCheckpoint,
    resolvedTheme,
    timestampFormat,
    timelineAnchorMessageId,
    composerTimelineInset,
    setTimelineOverflows,
    loadEarlierTurns,
    showScrollToBottom,
    scrollToEndClearance,
    t,
    setComposerOverlayElement,
    forceExpandedMobileComposer,
    multipleModelSelections,
    setMultipleModelSelections,
    environmentId,
    routeThreadRef,
    activeThreadId,
    routeServerThreadShell,
    isLocalDraftThread,
    isConnecting,
    feedbackUploading,
    composerHasNonPromptContent,
    respondingRequestIds,
    threadSyncPhase,
    runtimeMode,
    settings,
    restingComposerControlsHost,
    setRestingComposerControlsVisible,
    getTimelineScrollableNode,
    isTimelineAtLogicalEnd,
    timelineOverflows,
    promptRef,
    composerImagesRef,
    composerFilesRef,
    composerTerminalContextsRef,
    branchToolbarRef,
    setPendingServerThreadBranch,
    canCheckoutPullRequestIntoThread,
    setRestingComposerControlsHost,
    activePreviewMiniPlayer,
    previewMiniPlayerVisible,
    composerOverlayElement,
    pullRequestDialogState,
    mountedTerminalThreadRefs,
    rightPanelPresent,
    renderedRightPanelSurfaces,
    activePreviewState,
    resolvePreviewRuntimeTabId,
    activeTerminalLabelsById,
    panelAnimationDurationMs,
    routeThreadKey,
    expandedImage,
  } = threadState;
  const projectEnvironment = useChatViewProjectAndEnvironment({ threadState });
  const {
    activeProject,
    configuredPreviewUrls,
    pullRequestsCapabilityKnown,
    supportsPullRequests,
    latestTurnSettled,
    activeLatestTurn,
    providerAccentColors,
    handleFilePendingChange,
    pendingFileSurfaceIds,
    activeProjectScripts,
    handleNewThreadInActiveProject,
    activeDraftLogicalProjectKey,
    handleOpenDraftProjectSettings,
    activeRunningTurnId,
    activeProjectRef,
    serverConfig,
    attachmentUploadsCapabilityKnown,
    supportsAttachmentUploads,
    supportsQuestionAttachments,
    maxFileAttachmentBytes,
    projectCloneSendBlockReason,
    activeEnvironmentUnavailableState,
    activeEnvironmentUnavailable,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    projectMemoryCapability,
    showComposerEnvironmentIndicator,
    envLocked,
    openPullRequestDialog,
    hasMultipleEnvironments,
    loadBalancingSettings,
    logicalProjectEnvironments,
    closePullRequestDialog,
    handlePreparedPullRequestThread,
  } = projectEnvironment;
  const timelineData = useChatViewTimelineData({ threadState, projectEnvironment });
  const {
    agentPanelModel,
    workspaceMutationId,
    threadActivities,
    agentPanelLead,
    paintOnlyDisplayedTimeline,
    isWorking,
    isPreparingWorktree,
    isCompacting,
    activeWorkStartedAt,
    worktreeSetup,
    onCancelWorktreeSetup,
    onOpenWorktreeSetupTerminal,
    displayedTimeline,
    displayedThreadRef,
    displayedTimelineKey,
    supportsConversationRollback,
    openFileAttachment,
    downloadFileAttachment,
    activeProviderStatus,
    needsInput,
    pillWorking,
    timelineMessages,
    phase,
    isSendBusy,
    worktreeSetupBlocksSend,
    usageLimitsOffered,
    usageLimitsKey,
    openUsageLimits,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    interactionMode,
    activeContextWindow,
  } = timelineData;
  const terminalsAndScripts = useChatViewTerminalsAndScripts({
    threadState,
    projectEnvironment,
    timelineData,
  });
  const {
    keybindings,
    toggleTerminalVisibility,
    activeTerminalLaunchContext,
    addTerminalContextToDraft,
    splitTerminalShortcutLabel,
    splitTerminalVerticalShortcutLabel,
    newTerminalShortcutLabel,
    closeTerminalShortcutLabel,
    activeThreadMetadata,
    pullRequestsSurfaceAvailable,
    visiblePullRequestCount,
    addPullRequestsSurface,
    activeWorkspaceRoot,
    availableEditors,
    openFileSurface,
    deviceSetupThread,
    setDeviceSetupThread,
    deviceState,
    activeProjectRepository,
    openProjectPullRequest,
    gitCwd,
    runProjectScript,
    saveProjectScript,
    updateProjectScript,
    deleteProjectScript,
    visibleProviderStatus,
    setDismissedProviderStatusBannerKey,
    providerStatusBannerKey,
    openProviderSetup,
    setThreadError,
    addAgentsSurface,
    useArtifactTemplate,
    runShellCommand,
    heldPaintContext,
    isDraftHeroState,
    hasTimelineTopBanner,
    attachDraftHeroTransitionGroupRef,
    showComposerContextStrip,
    attachDraftHeroComposerAnchorRef,
    isGitRepo,
    requestInterrupt,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer,
    scheduleComposerFocus,
    mountComposerContextStrip,
    onEnvironmentChange,
    autoEnvironmentLabel,
    onAutoEnvironment,
    stopAgentsConfirmCount,
    setStopAgentsConfirmCount,
    onInterrupt,
    createBrowserSurface,
    addDiffSurface,
    addFilesSurface,
    addWorkflowsSurface,
    workflowsSurfaceAvailable,
    addDeviceSurface,
  } = terminalsAndScripts;
  const rightPanel = useChatViewRightPanel({
    threadState,
    projectEnvironment,
    terminalsAndScripts,
  });
  const {
    toggleRightPanel,
    toggleRightPanelMaximized,
    splitPanelTerminal,
    splitPanelTerminalVertical,
    addTerminalSurface,
    activatePanelTerminal,
    closePanelTerminal,
    closeRightPanelSurface,
    activateRightPanelSurface,
    closeOtherRightPanelSurfaces,
    closeRightPanelSurfacesToRight,
    closeAllRightPanelSurfaces,
    copyRightPanelFilePath,
    closePreviewPanel,
  } = rightPanel;
  const timelineScroll = useChatViewTimelineScroll({
    threadState,
    projectEnvironment,
    timelineData,
    terminalsAndScripts,
  });
  const {
    onTimelineAnchorReady,
    timelineLiveFollowEnabled,
    onIsAtEndChange,
    onToolOutputCollapsedAtEnd,
    cancelTimelineLiveFollowForUserNavigation,
    cancelPositionRestoreRef,
    scrollToEnd,
    onComposerPageScrollKeyDown,
    onComposerPageScrollKeyUp,
    onComposerPageScrollRelease,
  } = timelineScroll;
  const threadStatus = useChatViewThreadStatus({
    threadState,
    projectEnvironment,
    timelineData,
    terminalsAndScripts,
  });
  const {
    composerBannerItems,
    activeComposerTasksProgress,
    activeComposerTaskSteps,
    compactThreadUnavailable,
    compactDisabled,
    compactDisabledReason,
    publishComposerOverlayHeight,
    onComposerRestingChange,
    startFromOrigin,
    envMode,
    canOverrideServerThreadEnvMode,
    activeThreadBranch,
    projectMemoryRecoveryDialog,
    branchRestoreConfirmOpen,
    setBranchRestoreConfirmOpen,
    localCheckoutBranchMismatch,
    handleSwitchCheckoutToThread,
    addPullRequestSurface,
    pullRequestSurfaceAvailable,
    activeWorktreePath,
    closeExpandedImage,
  } = threadStatus;
  const shortcutsAndRevert = useChatViewShortcutsAndRevert({
    threadState,
    projectEnvironment,
    timelineData,
    terminalsAndScripts,
    rightPanel,
    timelineScroll,
    threadStatus,
  });
  const {
    getShortcutContext,
    queuedMessages,
    onCompactContext,
    pendingRevert,
    setPendingRevert,
    onRevertToTurnCount,
  } = shortcutsAndRevert;
  const pendingRequests = useChatViewPendingRequests({
    threadState,
    timelineData,
    terminalsAndScripts,
    rightPanel,
    timelineScroll,
    threadStatus,
    shortcutsAndRevert,
  });
  const {
    onSteerQueuedMessage,
    onRemoveQueuedMessage,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onDismissUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
  } = pendingRequests;
  const sendState = useChatViewSend({
    threadState,
    projectEnvironment,
    timelineData,
    terminalsAndScripts,
    rightPanel,
    timelineScroll,
    threadStatus,
    shortcutsAndRevert,
    pendingRequests,
  });
  const { onSend } = sendState;
  const actions = useChatViewActions({
    threadState,
    projectEnvironment,
    timelineData,
    terminalsAndScripts,
    threadStatus,
    shortcutsAndRevert,
    sendState,
  });
  const {
    onWorktreeSetupWorkLocally,
    onOpenTurnDiff,
    onRevertTimelineTurn,
    onExpandTimelineImage,
    onImplementPlanInNewThread,
    onProviderModelSelect,
    getModelDisabledReason,
    onEnvModeChange,
    onStartFromOriginChange,
  } = actions;

  // Empty state: no active thread
  if (!activeThread) {
    return <NoActiveThreadState />;
  }

  const panelToggleControls = (
    <PanelLayoutControls
      terminalAvailable={activeProject !== null}
      terminalOpen={terminalUiState.terminalOpen}
      terminalShortcutLabel={shortcutLabelForCommand(keybindings, "terminal.toggle")}
      rightPanelAvailable={activeProject !== null}
      rightPanelOpen={rightPanelOpen}
      rightPanelShortcutLabel={shortcutLabelForCommand(keybindings, "rightPanel.toggle")}
      // Suppressed while the Agents surface is visible: the roster itself is
      // on screen, so the toggle badge would be pointing at nothing.
      liveAgentCount={
        rightPanelOpen && activeRightPanelSurface?.kind === "agents" ? 0 : agentPanelModel.liveCount
      }
      onToggleTerminal={toggleTerminalVisibility}
      onToggleRightPanel={toggleRightPanel}
    />
  );
  const panelLayoutControls = (
    <div
      className={cn(
        // Keep one viewport anchor inside the header's no-drag region. The
        // header can shrink behind the right panel without moving the controls.
        "pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] z-50 mr-px flex h-[var(--workspace-topbar-height)] items-center gap-1 [-webkit-app-region:no-drag]",
      )}
      data-workspace-titlebar-controls
    >
      {!shouldUseRightPanelSheet ? (
        <span
          aria-hidden={!rightPanelOpen}
          className={cn(
            "flex shrink-0",
            panelAnimationsActive &&
              "motion-safe:transition-opacity motion-safe:duration-(--panel-animation-duration) motion-safe:ease-out",
            rightPanelOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
          )}
          inert={!rightPanelOpen}
        >
          <RightPanelMaximizeControl
            maximized={rightPanelMaximized}
            onToggle={toggleRightPanelMaximized}
          />
        </span>
      ) : null}
      <div className="pointer-events-auto flex h-full items-center">{panelToggleControls}</div>
    </div>
  );
  const rightPanelContent = activeThreadRef ? (
    renderedRightPanelSurface?.kind === "preview" ? (
      <Suspense fallback={null}>
        <PreviewPanel
          mode="embedded"
          threadRef={activeThreadRef}
          tabId={renderedRightPanelSurface.resourceId}
          configuredUrls={configuredPreviewUrls}
          visible={rightPanelOpen}
          onSendAnnotation={(annotation, image) => {
            void onSend(undefined, "foreground", { annotation, image });
          }}
        />
      </Suspense>
    ) : renderedRightPanelSurface?.kind === "terminal" ? (
      <PersistentThreadTerminalPanel
        visible={rightPanelOpen}
        threadRef={activeThreadRef}
        surface={renderedRightPanelSurface}
        launchContext={activeTerminalLaunchContext ?? null}
        focusRequestId={terminalFocusRequestId}
        keybindings={keybindings}
        onAddTerminalContext={addTerminalContextToDraft}
        onSplitTerminal={splitPanelTerminal}
        onSplitTerminalVertical={splitPanelTerminalVertical}
        onNewTerminal={addTerminalSurface}
        onActiveTerminalChange={activatePanelTerminal}
        onCloseTerminal={closePanelTerminal}
        splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
        splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
        newShortcutLabel={newTerminalShortcutLabel ?? undefined}
        closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
      />
    ) : renderedRightPanelSurface?.kind === "diff" ? (
      <Suspense fallback={null}>
        <DiffPanel
          key={activeThreadKey}
          mode="embedded"
          composerDraftTarget={composerDraftTarget}
          workspaceMutationId={workspaceMutationId}
        />
      </Suspense>
    ) : renderedRightPanelSurface?.kind === "pull-request" && !pullRequestsCapabilityKnown ? (
      <PullRequestDetailGhost />
    ) : renderedRightPanelSurface?.kind === "pull-request" && !supportsPullRequests ? (
      <PullRequestsUnavailableState
        title="Pull requests unavailable"
        error="Update this environment's OOP server to browse pull requests."
      />
    ) : renderedRightPanelSurface?.kind === "pull-request" ? (
      // No onClose: the surface tab's own X owns closing here, and a second X in the header
      // would be the same action twice. The thread context also drops the checkout button, so it
      // is only right for the thread's own pull request, whose branch is already under the
      // reader's feet. A link the agent wrote can open any other one here, and that one has to be
      // checkable out like it is anywhere else.
      <PullRequestDetailPanel
        getShortcutContext={getShortcutContext}
        shortcutsEnabled={
          rightPanelOpen && activeRightPanelSurface?.id === renderedRightPanelSurface.id
        }
        key={`${renderedRightPanelSurface.host ?? ""}:${renderedRightPanelSurface.repository}#${renderedRightPanelSurface.number}`}
        environmentId={activeThread.environmentId}
        onSelectPullRequest={(reference) => {
          if (activeThreadRef)
            useRightPanelStore.getState().openPullRequest(activeThreadRef, {
              projectId: reference.projectId,
              repository: reference.repository,
              number: reference.number,
              ...(reference.host ? { host: reference.host } : {}),
            });
        }}
        threadRef={activeThreadRef}
        reference={{
          projectId: renderedRightPanelSurface.projectId as ProjectId,
          ...(renderedRightPanelSurface.host ? { host: renderedRightPanelSurface.host } : {}),
          repository: renderedRightPanelSurface.repository,
          number: renderedRightPanelSurface.number,
        }}
        context={pullRequestPanelContext(
          {
            projectId: activeThreadMetadata?.projectId ?? null,
            pullRequests: activeThreadMetadata?.pullRequests,
            linkedPullRequest: activeThreadMetadata?.linkedPullRequest,
            branchPullRequest: activeThreadMetadata?.branchPullRequest,
          },
          renderedRightPanelSurface,
        )}
        composerDraftTarget={composerDraftTarget}
        onBack={
          activeThreadRef !== null && pullRequestsSurfaceAvailable && visiblePullRequestCount > 1
            ? addPullRequestsSurface
            : undefined
        }
      />
    ) : renderedRightPanelSurface?.kind === "pull-requests" && activeThreadRef ? (
      <ThreadPullRequestsPanel threadRef={activeThreadRef} />
    ) : renderedRightPanelSurface?.kind === "agents" ? (
      <AgentsPanel
        model={agentPanelModel}
        environmentId={activeThreadRef?.environmentId ?? null}
        threadId={activeThreadRef?.threadId ?? null}
        activities={threadActivities}
        activeTurnId={latestTurnSettled ? null : (activeLatestTurn?.turnId ?? null)}
        activeTurnStartedAt={
          latestTurnSettled
            ? null
            : (activeLatestTurn?.startedAt ?? activeLatestTurn?.requestedAt ?? null)
        }
        lead={agentPanelLead}
        accentColors={providerAccentColors}
      />
    ) : renderedRightPanelSurface?.kind === "workflows" ? (
      <WorkflowsPanel
        activities={threadActivities}
        agents={agentPanelModel}
        lead={agentPanelLead}
        environmentId={activeThreadRef?.environmentId ?? null}
        threadId={activeThreadRef?.threadId ?? null}
        activeTurnId={latestTurnSettled ? null : (activeLatestTurn?.turnId ?? null)}
        activeTurnStartedAt={
          latestTurnSettled
            ? null
            : (activeLatestTurn?.startedAt ?? activeLatestTurn?.requestedAt ?? null)
        }
      />
    ) : renderedRightPanelSurface?.kind === "device" ? (
      <Suspense fallback={null}>
        <DevicePanel
          mode="embedded"
          threadRef={activeThreadRef}
          key={renderedRightPanelSurface.id}
          surface={renderedRightPanelSurface}
          visible={rightPanelOpen}
          onDismissSetup={() => {
            closeRightPanelSurface(renderedRightPanelSurface);
            useRightPanelStore.getState().show(activeThreadRef);
          }}
        />
      </Suspense>
    ) : (renderedRightPanelSurface?.kind === "files" ||
        renderedRightPanelSurface?.kind === "file") &&
      ((activeProject && activeWorkspaceRoot) ||
        (renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment)) ? (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${activeThread.environmentId}:${
            renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment
              ? `attachment:${renderedRightPanelSurface.attachment.id}`
              : activeWorkspaceRoot
          }`}
          environmentId={activeThread.environmentId}
          cwd={activeWorkspaceRoot ?? ""}
          projectName={activeProject?.title ?? ""}
          threadRef={activeThreadRef}
          composerDraftTarget={composerDraftTarget}
          keybindings={keybindings}
          availableEditors={availableEditors}
          relativePath={
            renderedRightPanelSurface.kind === "file"
              ? renderedRightPanelSurface.relativePath
              : null
          }
          {...(renderedRightPanelSurface.kind === "file" && renderedRightPanelSurface.attachment
            ? { attachment: renderedRightPanelSurface.attachment }
            : {})}
          revealLine={
            renderedRightPanelSurface.kind === "file"
              ? (renderedRightPanelSurface.revealLine ?? null)
              : null
          }
          revealRequestId={
            renderedRightPanelSurface.kind === "file"
              ? renderedRightPanelSurface.revealRequestId
              : 0
          }
          onOpenFile={openFileSurface}
          onPendingChange={handleFilePendingChange}
          selectedFilePending={
            renderedRightPanelSurface.kind === "file" &&
            pendingFileSurfaceIds.has(renderedRightPanelSurface.id)
          }
          workspaceMutationId={workspaceMutationId}
        />
      </Suspense>
    ) : null
  ) : null;

  const workspaceFileDropHandlers = makeWorkspaceFileDropHandlers({
    setDragActive: setIsWorkspaceFileDragActive,
    addFiles: (files) => composerRef.current?.addDroppedFiles(files),
    addFolders: (folders) => composerRef.current?.addDroppedFolders(folders),
  });

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
      <Dialog
        open={
          deviceSetupThread !== null &&
          deviceSetupThread.environmentId === activeThreadRef?.environmentId &&
          deviceSetupThread.threadId === activeThreadRef?.threadId
        }
        onOpenChange={(open) => {
          if (!open) setDeviceSetupThread(null);
        }}
      >
        <WizardPopup>
          {activeThreadRef ? (
            <DeviceSetup
              environmentId={activeThreadRef.environmentId}
              state={deviceState}
              onComplete={() => {
                useRightPanelStore.getState().open(activeThreadRef, "device");
                setDeviceSetupThread(null);
              }}
            />
          ) : null}
        </WizardPopup>
      </Dialog>
      {rightPanelControlsAtRoot ? panelLayoutControls : null}
      <div
        className={cn(
          "flex min-h-0 min-w-0 flex-col overflow-x-hidden",
          rightPanelMaximized ? "w-0 flex-none" : "flex-1",
        )}
        data-chat-column-maximized-away={rightPanelMaximized ? "true" : "false"}
      >
        {/* Top bar */}
        <WorkspacePageHeader
          data-chat-header
          electron={isElectron}
          reserveNativeControls={reserveTitleBarControlInset && !inlineRightPanelOwnsTitleBar}
          className="relative bg-background"
        >
          {isElectron && rightPanelControlsAtRoot ? (
            <span
              aria-hidden
              className="pointer-events-none fixed top-[var(--workspace-controls-top)] right-[var(--workspace-controls-right)] h-[var(--workspace-topbar-height)] w-28 [-webkit-app-region:no-drag]"
            />
          ) : null}
          {!rightPanelControlsAtRoot && !rightPanelControlsInPanel ? panelLayoutControls : null}
          <ChatHeader
            {...(!supportsPullRequests || activeProjectRepository === null
              ? {}
              : { onOpenPullRequest: openProjectPullRequest })}
            activeThreadEnvironmentId={activeThread.environmentId}
            activeThreadId={activeThread.id}
            {...(routeKind === "draft" && draftId ? { draftId } : {})}
            activeThreadTitle={activeThread.title}
            isServerThread={isServerThread}
            activeProject={activeProject}
            openInCwd={gitCwd}
            activeProjectScripts={activeProjectScripts}
            preferredScriptId={
              activeProject ? (lastInvokedScriptByProjectId[activeProject.id] ?? null) : null
            }
            keybindings={keybindings}
            availableEditors={availableEditors}
            rightPanelOpen={rightPanelOpen}
            gitCwd={gitCwd}
            onNewThreadInProject={handleNewThreadInActiveProject}
            {...(activeDraftLogicalProjectKey
              ? { onOpenProjectSettings: handleOpenDraftProjectSettings }
              : {})}
            onRunProjectScript={runProjectScript}
            onAddProjectScript={saveProjectScript}
            onUpdateProjectScript={updateProjectScript}
            onDeleteProjectScript={deleteProjectScript}
          />
        </WorkspacePageHeader>

        {/* Main content area with optional plan sidebar */}
        <div className="flex min-h-0 min-w-0 flex-1">
          {/* Chat column */}
          <div
            className="relative flex min-h-0 min-w-0 flex-1 flex-col"
            data-chat-workspace-drop-target="true"
            onDragEnter={workspaceFileDropHandlers.onDragEnter}
            onDragOver={workspaceFileDropHandlers.onDragOver}
            onDragLeave={workspaceFileDropHandlers.onDragLeave}
            onDrop={workspaceFileDropHandlers.onDrop}
          >
            {isWorkspaceFileDragActive ? (
              <div
                className="pointer-events-none absolute inset-2 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/[0.035]"
                data-chat-workspace-drop-overlay="true"
              >
                <div
                  role="status"
                  className="flex items-center gap-2 rounded-full border border-primary/25 bg-background/95 px-4 py-2.5 text-sm font-medium text-foreground shadow-lg"
                >
                  <PaperclipIcon className="size-4 text-primary" aria-hidden="true" />
                  Drop files to attach
                </div>
              </div>
            ) : null}
            {/* Banners overlay the timeline without changing its content height. */}
            <div className="pointer-events-none absolute inset-x-0 top-0 z-20 flex flex-col">
              <ProviderStatusBanner
                status={visibleProviderStatus}
                onDismiss={() => setDismissedProviderStatusBannerKey(providerStatusBannerKey)}
                onOpenProviderSetup={openProviderSetup}
              />
              <ThreadErrorBanner
                error={visibleThreadError}
                chatGptUsageLimit={isChatGptUsageLimitError(threadActivities, visibleThreadError)}
                onDismiss={() => {
                  setThreadError(activeThread.id, null);
                  dismissThreadErrorBannerForSession(threadErrorBannerKey);
                  setThreadErrorBannerDismissTick((tick) => tick + 1);
                }}
              />
            </div>
            {/* Messages Wrapper */}
            <div className="relative flex min-h-0 flex-1 flex-col bg-background">
              {/* Messages — LegendList handles virtualization and scrolling internally */}
              <MessagesTimeline
                citationRequest={paintOnlyDisplayedTimeline ? null : citationRequest}
                citationHistoryLoading={threadDetailLoading}
                {...(!paintOnlyDisplayedTimeline
                  ? {
                      onCiteAssistantText: citeAssistantText,
                      agentPanelModel,
                      onOpenAgents: addAgentsSurface,
                      onUseArtifactTemplate: useArtifactTemplate,
                      ...(activeProject ? { onRunShellCommand: runShellCommand } : {}),
                    }
                  : {})}
                isWorking={!paintOnlyDisplayedTimeline && isWorking}
                isPreparingWorktree={!paintOnlyDisplayedTimeline && isPreparingWorktree}
                isCompacting={!paintOnlyDisplayedTimeline && isCompacting}
                activeTurnStartedAt={paintOnlyDisplayedTimeline ? null : activeWorkStartedAt}
                worktreeSetup={paintOnlyDisplayedTimeline ? null : worktreeSetup}
                onCancelWorktreeSetup={onCancelWorktreeSetup}
                {...(draftId ? { onWorktreeSetupWorkLocally } : {})}
                {...(onOpenWorktreeSetupTerminal ? { onOpenWorktreeSetupTerminal } : {})}
                listRef={legendListRef}
                timelineEntries={displayedTimeline.entries}
                latestTurn={paintOnlyDisplayedTimeline ? null : activeLatestTurn}
                runningTurnId={paintOnlyDisplayedTimeline ? null : activeRunningTurnId}
                turnDiffSummaries={
                  paintOnlyDisplayedTimeline
                    ? EMPTY_HELD_TURN_DIFF_SUMMARIES
                    : activeThread.checkpoints
                }
                activeThreadEnvironmentId={
                  displayedThreadRef?.environmentId ?? activeThread.environmentId
                }
                routeThreadKey={displayedTimelineKey}
                displayThreadKey={displayedTimelineKey}
                onOpenTurnDiff={paintOnlyDisplayedTimeline ? noopHeldTurnDiff : onOpenTurnDiff}
                supportsConversationRollback={
                  !paintOnlyDisplayedTimeline && supportsConversationRollback
                }
                onRevertToTurnCount={
                  paintOnlyDisplayedTimeline ? noopHeldRevert : onRevertTimelineTurn
                }
                isRevertingCheckpoint={!paintOnlyDisplayedTimeline && isRevertingCheckpoint}
                onImageExpand={onExpandTimelineImage}
                onFileOpen={paintOnlyDisplayedTimeline ? noopHeldAttachment : openFileAttachment}
                onFileDownload={
                  paintOnlyDisplayedTimeline ? noopHeldAttachment : downloadFileAttachment
                }
                markdownCwd={
                  paintOnlyDisplayedTimeline
                    ? (heldPaintContext?.markdownCwd ?? undefined)
                    : (gitCwd ?? undefined)
                }
                resolvedTheme={resolvedTheme}
                timestampFormat={timestampFormat}
                workspaceRoot={
                  paintOnlyDisplayedTimeline
                    ? (heldPaintContext?.workspaceRoot ?? undefined)
                    : activeWorkspaceRoot
                }
                skills={
                  activeProviderStatus
                    ? resolveProviderSkillsForCwd(activeProviderStatus, gitCwd)
                    : EMPTY_PROVIDER_SKILLS
                }
                anchorMessageId={paintOnlyDisplayedTimeline ? null : timelineAnchorMessageId}
                onAnchorReady={onTimelineAnchorReady}
                contentInsetEndAdjustment={composerTimelineInset}
                liveFollowEnabled={!paintOnlyDisplayedTimeline && timelineLiveFollowEnabled}
                onIsAtEndChange={onIsAtEndChange}
                onContentOverflowChange={setTimelineOverflows}
                onToolOutputCollapsedAtEnd={onToolOutputCollapsedAtEnd}
                onManualNavigation={cancelTimelineLiveFollowForUserNavigation}
                cancelPositionRestoreRef={cancelPositionRestoreRef}
                hideEmptyPlaceholder={isDraftHeroState || threadDetailLoading}
                topFadeEnabled={!hasTimelineTopBanner}
                loadEarlier={paintOnlyDisplayedTimeline ? null : loadEarlierTurns}
                queuedMessages={paintOnlyDisplayedTimeline ? EMPTY_QUEUED_MESSAGES : queuedMessages}
                onSteerQueuedMessage={onSteerQueuedMessage}
                steerQueuedMessageShortcutLabel={shortcutLabelForCommand(
                  keybindings,
                  "thread.steerQueuedMessage",
                  { context: { terminalFocus: false } },
                )}
                onRemoveQueuedMessage={onRemoveQueuedMessage}
              />

              {/* scroll to end pill — shown when user has scrolled away from the live edge */}
              {showScrollToBottom && (
                <div
                  className="pointer-events-none absolute left-1/2 z-30 flex -translate-x-1/2 justify-center py-1.5"
                  style={{ bottom: scrollToEndClearance + 4 }}
                >
                  <Button
                    aria-label="Scroll to end"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      composerRef.current?.restoreAfterTimelineReachedEnd();
                      scrollToEnd(true);
                    }}
                    className="pointer-events-auto"
                    size="xs"
                    variant={needsInput ? "warning-outline" : "glass"}
                  >
                    {needsInput || pillWorking ? (
                      <span aria-hidden className="size-1.5 rounded-full bg-current" />
                    ) : (
                      <ChevronDownIcon className="size-3.5" />
                    )}
                    {needsInput
                      ? t("Needs your input")
                      : pillWorking
                        ? t("Working")
                        : "Scroll to end"}
                  </Button>
                </div>
              )}
            </div>

            {/* Input bar — centered hero while a draft has no messages, docked at the bottom otherwise */}
            <div
              ref={setComposerOverlayElement}
              inert={isRevertingCheckpoint}
              data-chat-composer-overlay="true"
              className={
                isDraftHeroState
                  ? "pointer-events-none absolute inset-0 z-20 flex items-center"
                  : "pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
              }
            >
              <div
                ref={attachDraftHeroTransitionGroupRef}
                className="w-full ps-(--workspace-gutter-start) pe-(--workspace-gutter-end)"
              >
                <div
                  data-chat-composer-stack="true"
                  className="group/composer-stack pointer-events-auto relative z-10 mx-auto w-full max-w-(--chat-max-width)"
                >
                  {isDraftHeroState ? (
                    <div className="absolute inset-x-0 bottom-full z-0">
                      <div
                        className="pb-8 group-has-data-[composer-shoulder-tab]/composer-stack:pb-4"
                        style={
                          forceExpandedMobileComposer
                            ? {
                                viewTransitionName: MOBILE_DRAFT_HEADLINE_VIEW_TRANSITION_NAME,
                              }
                            : undefined
                        }
                      >
                        <DraftHeroHeadline
                          draftId={draftId}
                          activeProjectRef={activeProjectRef}
                          activeProjectTitle={activeProject?.title ?? null}
                        />
                      </div>
                    </div>
                  ) : null}
                  <div
                    className="relative"
                    style={
                      forceExpandedMobileComposer
                        ? { viewTransitionName: MOBILE_COMPOSER_VIEW_TRANSITION_NAME }
                        : undefined
                    }
                  >
                    <ComposerSurface.Shell contextStrip={showComposerContextStrip}>
                      <ComposerSurface.Host>
                        <div ref={attachDraftHeroComposerAnchorRef} className="relative z-10">
                          <ChatComposer
                            multipleModelSelections={multipleModelSelections}
                            supportsMultipleModels={
                              serverConfig?.environment.capabilities.requiredWorktreeBootstrap ===
                              true
                            }
                            onMultipleModelSelectionsChange={setMultipleModelSelections}
                            composerRef={composerRef}
                            composerDraftTarget={composerDraftTarget}
                            environmentId={environmentId}
                            attachmentUploadsCapabilityKnown={attachmentUploadsCapabilityKnown}
                            supportsAttachmentUploads={supportsAttachmentUploads}
                            supportsQuestionAttachments={supportsQuestionAttachments}
                            maxFileAttachmentBytes={maxFileAttachmentBytes}
                            routeKind={routeKind}
                            routeThreadRef={routeThreadRef}
                            draftId={draftId}
                            activeThreadId={activeThreadId}
                            activeThreadEnvironmentId={activeThread?.environmentId}
                            activeThread={activeThread}
                            activeThreadShell={routeServerThreadShell}
                            promptHistoryMessages={timelineMessages}
                            isServerThread={isServerThread}
                            isLocalDraftThread={isLocalDraftThread}
                            forceExpandedOnMobile={forceExpandedMobileComposer && isDraftHeroState}
                            projectSelectionRequired={isLocalDraftThread && activeProject === null}
                            phase={phase}
                            isConnecting={isConnecting}
                            isSendBusy={isSendBusy}
                            isRevertingCheckpoint={isRevertingCheckpoint}
                            sendDisabledReason={
                              isRevertingCheckpoint
                                ? "Rewinding conversation"
                                : feedbackUploading
                                  ? "Sending feedback"
                                  : threadDetailLoading
                                    ? "Messages loading"
                                    : worktreeSetupBlocksSend
                                      ? "Preparing worktree"
                                      : projectCloneSendBlockReason
                            }
                            isPreparingWorktree={isPreparingWorktree}
                            bannerItems={composerBannerItems}
                            // With attachments or contexts aboard the pick just inserts the
                            // text, so it sends as a prompt like the typed path would.
                            onUsageLimitsCommand={
                              usageLimitsOffered &&
                              usageLimitsKey !== null &&
                              !composerHasNonPromptContent
                                ? openUsageLimits
                                : undefined
                            }
                            environmentUnavailable={activeEnvironmentUnavailableState}
                            activePendingApproval={activePendingApproval}
                            pendingApprovals={pendingApprovals}
                            pendingUserInputs={pendingUserInputs}
                            activePendingProgress={activePendingProgress}
                            activePendingResolvedAnswers={activePendingResolvedAnswers}
                            activePendingIsResponding={activePendingIsResponding}
                            activePendingDraftAnswers={activePendingDraftAnswers}
                            activePendingQuestionIndex={activePendingQuestionIndex}
                            respondingRequestIds={respondingRequestIds}
                            showPlanFollowUpPrompt={showPlanFollowUpPrompt}
                            activeProposedPlan={activeProposedPlan}
                            activeTasksProgress={activeComposerTasksProgress}
                            activeTaskSteps={activeComposerTaskSteps}
                            threadSyncPhase={activeEnvironmentUnavailable ? null : threadSyncPhase}
                            runtimeMode={runtimeMode}
                            interactionMode={interactionMode}
                            lockedProvider={lockedProvider}
                            providerStatuses={providerStatuses as ServerProvider[]}
                            providerCatalogKnown={serverConfig !== null}
                            activeProjectDefaultModelSelection={activeProjectDefaultModelSelection}
                            activeThreadModelSelection={activeThread?.modelSelection}
                            activeContextWindow={activeContextWindow}
                            compactThreadUnavailable={compactThreadUnavailable}
                            compactDisabled={compactDisabled}
                            compactDisabledReason={compactDisabledReason}
                            resolvedTheme={resolvedTheme}
                            settings={settings}
                            keybindings={keybindings}
                            terminalOpen={Boolean(terminalUiState.terminalOpen)}
                            gitCwd={gitCwd}
                            projectMemoryCapability={projectMemoryCapability}
                            pullRequestProjectId={
                              supportsPullRequests ? (activeProject?.id ?? null) : null
                            }
                            pullRequestRepository={
                              supportsPullRequests ? activeProjectRepository : null
                            }
                            restingControlsHost={restingComposerControlsHost}
                            restingControlsHaveLeadingContext={
                              isGitRepo || showComposerEnvironmentIndicator
                            }
                            onRestingControlsVisibilityChange={setRestingComposerControlsVisible}
                            getTimelineScrollableNode={getTimelineScrollableNode}
                            isTimelineAtLogicalEnd={isTimelineAtLogicalEnd}
                            timelineOverflows={timelineOverflows}
                            onComposerOverlayHeightChange={publishComposerOverlayHeight}
                            onRestingChange={onComposerRestingChange}
                            promptRef={promptRef}
                            composerImagesRef={composerImagesRef}
                            composerFilesRef={composerFilesRef}
                            composerTerminalContextsRef={composerTerminalContextsRef}
                            onPageScrollKeyDown={onComposerPageScrollKeyDown}
                            onPageScrollKeyUp={onComposerPageScrollKeyUp}
                            onPageScrollRelease={onComposerPageScrollRelease}
                            onCompactContext={onCompactContext}
                            onSend={onSend}
                            onInterrupt={requestInterrupt}
                            liveBackgroundAgentCount={agentPanelModel.liveCount}
                            onImplementPlanInNewThread={onImplementPlanInNewThread}
                            onRespondToApproval={onRespondToApproval}
                            onSelectActivePendingUserInputOption={
                              onSelectActivePendingUserInputOption
                            }
                            onAdvanceActivePendingUserInput={onAdvanceActivePendingUserInput}
                            onDismissActivePendingUserInput={onDismissUserInput}
                            onPreviousActivePendingUserInputQuestion={
                              onPreviousActivePendingUserInputQuestion
                            }
                            onChangeActivePendingUserInputCustomAnswer={
                              onChangeActivePendingUserInputCustomAnswer
                            }
                            onProviderModelSelect={onProviderModelSelect}
                            onOpenProviderSetup={openProviderSetup}
                            getModelDisabledReason={getModelDisabledReason}
                            toggleInteractionMode={toggleInteractionMode}
                            handleRuntimeModeChange={handleRuntimeModeChange}
                            handleInteractionModeChange={handleInteractionModeChange}
                            focusComposer={focusComposer}
                            scheduleComposerFocus={scheduleComposerFocus}
                            setThreadError={setThreadError}
                            onExpandImage={onExpandTimelineImage}
                            onFileOpen={openFileAttachment}
                          />
                        </div>
                      </ComposerSurface.Host>
                      <div className="min-h-0">
                        <div
                          data-terminal-open={terminalUiState.terminalOpen ? "true" : undefined}
                          className="relative z-0"
                        >
                          {mountComposerContextStrip && (
                            <div className="pointer-events-auto">
                              <BranchToolbar
                                forceNewWorktree={multipleModelSelections !== null}
                                ref={branchToolbarRef}
                                environmentId={activeThread.environmentId}
                                threadId={activeThread.id}
                                showGitControls={isGitRepo}
                                {...(routeKind === "draft" && draftId ? { draftId } : {})}
                                onEnvModeChange={onEnvModeChange}
                                startFromOrigin={startFromOrigin}
                                onStartFromOriginChange={onStartFromOriginChange}
                                envMode={envMode}
                                {...(canOverrideServerThreadEnvMode
                                  ? {
                                      activeThreadBranchOverride: activeThreadBranch,
                                      onActiveThreadBranchOverrideChange:
                                        setPendingServerThreadBranch,
                                    }
                                  : {})}
                                envLocked={envLocked}
                                onComposerFocusRequest={scheduleComposerFocus}
                                {...(canCheckoutPullRequestIntoThread
                                  ? { onCheckoutPullRequestRequest: openPullRequestDialog }
                                  : {})}
                                {...(hasMultipleEnvironments ? { onEnvironmentChange } : {})}
                                autoEnvironmentLabel={autoEnvironmentLabel}
                                onAutoEnvironment={
                                  draftId &&
                                  !envLocked &&
                                  hasMultipleEnvironments &&
                                  loadBalancingSettings.loadBalancingEnabled
                                    ? onAutoEnvironment
                                    : undefined
                                }
                                availableEnvironments={logicalProjectEnvironments}
                                composerControlsHostRef={setRestingComposerControlsHost}
                                contextStripVisible={showComposerContextStrip}
                              />
                            </div>
                          )}
                        </div>
                      </div>
                    </ComposerSurface.Shell>
                    <div
                      aria-hidden
                      className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
                    />
                  </div>
                </div>
              </div>
            </div>

            {activeThreadRef && activePreviewMiniPlayer && previewMiniPlayerVisible ? (
              <ThreadPreviewMiniPlayer
                key={`${activeThreadKey}:${previewMiniPlayerSourceKey(activePreviewMiniPlayer.source)}`}
                threadRef={activeThreadRef}
                miniPlayer={activePreviewMiniPlayer}
                composerOverlayElement={isDraftHeroState ? null : composerOverlayElement}
              />
            ) : null}

            {projectMemoryRecoveryDialog}

            <AlertDialog
              open={stopAgentsConfirmCount !== null}
              onOpenChange={(open) => {
                if (!open) setStopAgentsConfirmCount(null);
              }}
            >
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("Stop background agents too?")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {stopAgentsConfirmCount === 1
                      ? t(
                          "1 background agent is still running. Stopping ends it and its work. Queued messages return to the composer.",
                        )
                      : t(
                          "{count} background agents are still running. Stopping ends them and their work. Queued messages return to the composer.",
                          { count: stopAgentsConfirmCount ?? 0 },
                        )}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" autoFocus />}>
                    {t("Keep running")}
                  </AlertDialogClose>
                  <Button
                    variant="destructive"
                    onClick={() => {
                      setStopAgentsConfirmCount(null);
                      void onInterrupt();
                    }}
                  >
                    {t("Stop all")}
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            <AlertDialog open={branchRestoreConfirmOpen} onOpenChange={setBranchRestoreConfirmOpen}>
              <AlertDialogPopup>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    Switch to{" "}
                    <code className="font-medium">
                      {localCheckoutBranchMismatch?.threadBranch ?? ""}
                    </code>
                    ?
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    You have uncommitted changes. They'll carry over to the other branch, or block
                    the switch if they conflict.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                  <Button
                    variant="default"
                    onClick={() => {
                      setBranchRestoreConfirmOpen(false);
                      void handleSwitchCheckoutToThread();
                    }}
                  >
                    Switch branch
                  </Button>
                </AlertDialogFooter>
              </AlertDialogPopup>
            </AlertDialog>

            {pullRequestDialogState ? (
              <PullRequestThreadDialog
                key={pullRequestDialogState.key}
                open
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                cwd={activeProject?.workspaceRoot ?? null}
                initialReference={pullRequestDialogState.initialReference}
                onOpenChange={(open) => {
                  if (!open) {
                    closePullRequestDialog();
                  }
                }}
                onPrepared={handlePreparedPullRequestThread}
              />
            ) : null}
          </div>
          {/* end chat column */}
        </div>
        {/* end horizontal flex container */}

        {mountedTerminalThreadRefs.map(({ key: mountedThreadKey, threadRef: mountedThreadRef }) => (
          <PersistentThreadTerminalDrawer
            key={mountedThreadKey}
            threadRef={mountedThreadRef}
            threadId={mountedThreadRef.threadId}
            active={mountedThreadKey === activeThreadKey}
            launchContext={
              mountedThreadKey === activeThreadKey ? (activeTerminalLaunchContext ?? null) : null
            }
            focusRequestId={mountedThreadKey === activeThreadKey ? terminalFocusRequestId : 0}
            splitShortcutLabel={splitTerminalShortcutLabel ?? undefined}
            splitVerticalShortcutLabel={splitTerminalVerticalShortcutLabel ?? undefined}
            newShortcutLabel={newTerminalShortcutLabel ?? undefined}
            closeShortcutLabel={closeTerminalShortcutLabel ?? undefined}
            keybindings={keybindings}
            onAddTerminalContext={addTerminalContextToDraft}
          />
        ))}
      </div>

      {rightPanelPresent && !shouldUseRightPanelSheet && activeThreadRef ? (
        <RightPanelTabs
          mode="inline"
          widthStorageKey={`t3code:preview-panel-width:${activeThreadKey}`}
          open={rightPanelOpen}
          maximized={rightPanelMaximized}
          surfaces={renderedRightPanelSurfaces}
          environmentId={activeThreadRef.environmentId}
          activeSurfaceId={renderedRightPanelSurface?.id ?? null}
          pendingSurfaceIds={pendingFileSurfaceIds}
          previewSessions={activePreviewState.sessions}
          desktopByTabId={activePreviewState.desktopByTabId}
          previewRuntimeTabId={resolvePreviewRuntimeTabId}
          terminalLabelsById={activeTerminalLabelsById}
          onActivate={activateRightPanelSurface}
          onCloseSurface={closeRightPanelSurface}
          onRenameDevice={(surfaceId, title) => {
            if (activeThreadRef)
              useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
          }}
          onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
          onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
          onCloseAllSurfaces={closeAllRightPanelSurfaces}
          onCopyFilePath={copyRightPanelFilePath}
          onAddBrowser={() => createBrowserSurface()}
          onAddBrowserInProfile={createBrowserSurface}
          onAddTerminal={addTerminalSurface}
          onAddDiff={addDiffSurface}
          onAddFiles={addFilesSurface}
          onAddPullRequest={addPullRequestSurface}
          onAddPullRequests={addPullRequestsSurface}
          onAddAgents={addAgentsSurface}
          onAddWorkflows={addWorkflowsSurface}
          workflowsAvailable={workflowsSurfaceAvailable}
          onAddDevice={addDeviceSurface}
          browserAvailable={isPreviewSupportedInRuntime()}
          terminalAvailable={activeProject !== null}
          diffAvailable={isServerThread && isGitRepo}
          filesAvailable={activeProject !== null}
          pullRequestAvailable={pullRequestSurfaceAvailable}
          pullRequestsAvailable={pullRequestsSurfaceAvailable}
          agentsAvailable
          deviceAvailable={activeThreadRef !== null}
          liveAgentCount={agentPanelModel.liveCount}
        >
          {rightPanelContent}
        </RightPanelTabs>
      ) : null}
      {rightPanelPresent && shouldUseRightPanelSheet && activeThreadRef ? (
        <RightPanelSheet
          animationDurationMs={panelAnimationsActive ? panelAnimationDurationMs : 0}
          open={rightPanelOpen}
          onClose={closePreviewPanel}
        >
          <RightPanelTabs
            mode="sheet"
            // Same effective inset as the closed-state titlebar controls
            // (pr-3 in the tab bar plus this pixel equals the absolute
            // right inset plus mr-px), so the cluster does not creep when
            // the sheet opens.
            layoutControls={
              rightPanelOpen ? (
                <div className="mr-px flex items-center">{panelToggleControls}</div>
              ) : null
            }
            surfaces={renderedRightPanelSurfaces}
            environmentId={activeThreadRef.environmentId}
            activeSurfaceId={renderedRightPanelSurface?.id ?? null}
            pendingSurfaceIds={pendingFileSurfaceIds}
            previewSessions={activePreviewState.sessions}
            desktopByTabId={activePreviewState.desktopByTabId}
            previewRuntimeTabId={resolvePreviewRuntimeTabId}
            terminalLabelsById={activeTerminalLabelsById}
            onActivate={activateRightPanelSurface}
            onCloseSurface={closeRightPanelSurface}
            onRenameDevice={(surfaceId, title) => {
              if (activeThreadRef)
                useRightPanelStore.getState().renameDevice(activeThreadRef, surfaceId, title);
            }}
            onCloseOtherSurfaces={closeOtherRightPanelSurfaces}
            onCloseSurfacesToRight={closeRightPanelSurfacesToRight}
            onCloseAllSurfaces={closeAllRightPanelSurfaces}
            onCopyFilePath={copyRightPanelFilePath}
            onAddBrowser={() => createBrowserSurface()}
            onAddBrowserInProfile={createBrowserSurface}
            onAddTerminal={addTerminalSurface}
            onAddDiff={addDiffSurface}
            onAddFiles={addFilesSurface}
            onAddPullRequest={addPullRequestSurface}
            onAddPullRequests={addPullRequestsSurface}
            onAddAgents={addAgentsSurface}
            onAddWorkflows={addWorkflowsSurface}
            workflowsAvailable={workflowsSurfaceAvailable}
            onAddDevice={addDeviceSurface}
            browserAvailable={isPreviewSupportedInRuntime()}
            terminalAvailable={activeProject !== null}
            diffAvailable={isServerThread && isGitRepo}
            filesAvailable={activeProject !== null}
            pullRequestAvailable={pullRequestSurfaceAvailable}
            pullRequestsAvailable={pullRequestsSurfaceAvailable}
            agentsAvailable
            deviceAvailable={activeThreadRef !== null}
            liveAgentCount={agentPanelModel.liveCount}
          >
            {rightPanelContent}
          </RightPanelTabs>
        </RightPanelSheet>
      ) : null}

      <AlertDialog
        open={pendingRevert !== null && pendingRevert.routeThreadKey === routeThreadKey}
        onOpenChange={(open) => {
          if (!open) setPendingRevert(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Edit from here?</AlertDialogTitle>
            <AlertDialogDescription>
              Rewind chat to before this message. Your prompt and attachments return to the
              composer.
              {activeWorktreePath === null
                ? " Files stay as they are because this thread shares the project directory."
                : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            {activeWorktreePath !== null ? (
              <Button
                variant="destructive"
                onClick={() => {
                  if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                  setPendingRevert(null);
                  void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, true);
                }}
              >
                Revert files too
              </Button>
            ) : null}
            <Button
              onClick={() => {
                if (!pendingRevert || pendingRevert.routeThreadKey !== routeThreadKey) return;
                setPendingRevert(null);
                void onRevertToTurnCount(pendingRevert.turnCount, pendingRevert.messageId, false);
              }}
            >
              Revert and keep changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <LinkPullRequestDialogHost />
      {expandedImage && (
        <ExpandedImageDialog
          key={expandedImageKey(expandedImage)}
          preview={expandedImage}
          onClose={closeExpandedImage}
        />
      )}
    </div>
  );
}
